/**
 * Unit tests for `commit_session_to_branch` orchestration.
 *
 * The integration tests at `test/integration/branch.test.ts` exercise the full
 * podman + host-git flow end-to-end. These unit tests cover the orchestration
 * paths that DON'T reach `stream_apply_from_sandbox` (which would require
 * mocking node:child_process's `spawn` EventEmitter contract — high cost,
 * low marginal value over the integration coverage):
 *
 *   1. Empty slice (no changes in the sandbox) — early return, no fallback.
 *   2. Oversized slice + no `confirm_oversized` callback — fallback + non-interactive warning.
 *   3. Oversized slice + callback returns false — fallback + "user request" warning.
 *   4. Missing patchlab branch on the host — fallback + branch-missing warning.
 *   5. Multi-repository fan-out — each repository gets an independent result.
 *   6. `advance_container_head` failure — warning logged, host commits preserved.
 *
 * Mocks: node:child_process (every podman call we expect), the branch
 * sibling modules (internals, create, predicates), and manifest. The mock
 * implementations dispatch on the podman subcommand so a stray call surfaces
 * as a clear error rather than a silent no-op.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawn: vi.fn(() => {
        throw new Error('spawn should not be reached in these orchestration tests');
    }),
}));

vi.mock('../../../src/branch/internals.js', () => ({
    run_git: vi.fn(),
    rev_parse: vi.fn(() => 'deadbeef'),
    list_other_local_branches: vi.fn(() => []),
}));

vi.mock('../../../src/branch/predicates.js', () => ({
    patchlab_branch_exists: vi.fn(() => true),
    is_git_repository: vi.fn(() => true),
    is_working_tree_dirty: vi.fn(() => false),
    detect_submodules: vi.fn(() => []),
    branch_exists: vi.fn(() => true),
    resolve_repository_root: vi.fn((root: string) => root),
}));

vi.mock('../../../src/branch/create.js', () => ({
    commit_tree_with_parent: vi.fn(() => 'newcommit'),
    make_temporary_index_path: vi.fn((patchlab_id: string, label: string) =>
        path.join(process.env.HOME ?? '/home', '.patchlab', `temporary-index-${patchlab_id}-${label}`),
    ),
    with_index_env: vi.fn((index_path: string) => ({ GIT_INDEX_FILE: index_path })),
    create_patchlab_branch: vi.fn(),
}));

vi.mock('../../../src/diff_path_rewrite.js', () => ({
    make_diff_path_rewriter: vi.fn(() => undefined),
}));

// Keep the real atomic_write_file (seed_single_repo_manifest writes a real
// manifest via write_manifest) while spying on safe_unlink, which several
// tests assert is called on the temp-file cleanup paths.
vi.mock('../../../src/safe_filesystem.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/safe_filesystem.js')>();
    return {
        ...actual,
        safe_unlink: vi.fn(),
    };
});

import { execFileSync } from 'node:child_process';
import {
    commit_session_to_branch,
    DEFAULT_MAX_DIFF_BYTES,
    type Commit_Session_Options,
} from '../../../src/branch/session_commit.js';
import { build_archive_path } from '../../../src/archive.js';
import { write_manifest, create_manifest } from '../../../src/manifest.js';
import { patchlab_branch_exists } from '../../../src/branch/predicates.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';
import {
    install_recording_logger_hooks,
    filter_recorded_messages,
} from '../../helpers/recording_logger.js';

const mocked_execFileSync = vi.mocked(execFileSync);
const mocked_patchlab_branch_exists = vi.mocked(patchlab_branch_exists);

const CONTAINER_NAME = 'patchlab-test-container';
const WORKSPACE = '/home/patchlab/workspace';
const REPOSITORY = '/host/repo';

function seed_single_repo_manifest(patchlab_id: string): void {
    const archive_directory = build_archive_path(patchlab_id);
    fs.mkdirSync(archive_directory, { recursive: true });
    const manifest = create_manifest(
        patchlab_id,
        [{ host_path: REPOSITORY, repository_root: REPOSITORY, source_prefix: '', mount_name: '' }],
        CONTAINER_NAME,
        'node:22-slim',
    );
    write_manifest(archive_directory, manifest);
}

function seed_multi_repo_manifest(patchlab_id: string, repositories: string[]): void {
    const archive_directory = build_archive_path(patchlab_id);
    fs.mkdirSync(archive_directory, { recursive: true });
    const manifest = create_manifest(
        patchlab_id,
        repositories.map((repository_root) => ({
            host_path: repository_root,
            repository_root,
            source_prefix: '',
            mount_name: path.basename(repository_root) || 'mount',
        })),
        CONTAINER_NAME,
        'node:22-slim',
    );
    write_manifest(archive_directory, manifest);
}

interface Podman_Call {
    arguments: string[];
}

/**
 * Build an `execFileSync` mock implementation that recognizes the podman
 * subcommand and returns the value the orchestrator expects. The
 * `slice_size_bytes` argument controls what `stat -c %s` returns for the
 * diff slice — the orchestrator's size-cap logic branches on it.
 */
function install_podman_mock_implementation(slice_size_bytes: number): { calls: Podman_Call[] } {
    const calls: Podman_Call[] = [];

    mocked_execFileSync.mockImplementation(((file: string, args?: readonly string[], options?: { encoding?: BufferEncoding }) => {
        if (file !== 'podman') {
            throw new Error(`unexpected execFileSync target: ${file}`);
        }
        const arguments_list = [...(args ?? [])];
        const arguments_set = new Set(arguments_list);
        calls.push({ arguments: arguments_list });

        // The size probe passes `encoding: 'utf-8'` so execFileSync returns
        // a string; all other calls leave encoding undefined and expect a
        // Buffer. Mirror that contract.
        if (arguments_list[0] === 'exec' && arguments_set.has('stat')) {
            const text = `${slice_size_bytes}\n`;
            return options?.encoding ? text : Buffer.from(text);
        }

        return options?.encoding ? '' : Buffer.from('');
    }) as typeof execFileSync);

    return { calls };
}

const default_options: Commit_Session_Options = {
    container_name: CONTAINER_NAME,
    workspace: WORKSPACE,
    tool_name: 'gemini-cli-oauth',
    created_at: '2026-06-09T00:00:00.000Z',
    author_name: 'Test',
    author_email: 'test@example.com',
};

describe('commit_session_to_branch — orchestration paths without stream_apply', () => {
    install_isolated_home_hooks('patchlab-session-commit-');
    const logger_handle = install_recording_logger_hooks();

    beforeEach(() => {
        mocked_execFileSync.mockReset();
        mocked_patchlab_branch_exists.mockReset();
        mocked_patchlab_branch_exists.mockReturnValue(true);
    });

    it('returns null commit and null fallback when the slice is empty', async () => {
        seed_single_repo_manifest('pl-empty-slice');
        const { calls } = install_podman_mock_implementation(0);

        const result = await commit_session_to_branch('pl-empty-slice', 1, default_options);

        expect(result.commit_shas[REPOSITORY]).toBeNull();
        expect(result.fallback_patches[REPOSITORY]).toBeNull();
        // Verify the orchestrator's three discrete podman steps before the
        // size check: stage (git add -A), slice (sh -c), size probe (stat).
        expect(calls.some((c) => c.arguments.includes('add') && c.arguments.includes('-A'))).toBe(true);
        expect(calls.some((c) => c.arguments.includes('stat'))).toBe(true);
    });

    it('cleans up the container-side slice temp file even on the empty-slice path', async () => {
        seed_single_repo_manifest('pl-empty-cleanup');
        const { calls } = install_podman_mock_implementation(0);

        await commit_session_to_branch('pl-empty-cleanup', 1, default_options);

        expect(calls.some((c) => c.arguments.includes('rm') && c.arguments.includes('-f'))).toBe(true);
    });

    it('writes a fallback and emits the non-interactive warning when oversized without a callback', async () => {
        seed_single_repo_manifest('pl-oversize-no-callback');
        install_podman_mock_implementation(10 * 1024 * 1024);

        const result = await commit_session_to_branch(
            'pl-oversize-no-callback',
            1,
            { ...default_options, max_diff_size_bytes: 1024 },
        );

        expect(result.commit_shas[REPOSITORY]).toBeNull();
        expect(result.fallback_patches[REPOSITORY]).toMatch(/fallback\..*\.patch$/);
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('no confirmation hook supplied'))).toBe(true);
    });

    it('writes a fallback and emits the "user request" warning when confirm_oversized returns false', async () => {
        seed_single_repo_manifest('pl-oversize-declined');
        install_podman_mock_implementation(10 * 1024 * 1024);

        const result = await commit_session_to_branch(
            'pl-oversize-declined',
            1,
            {
                ...default_options,
                max_diff_size_bytes: 1024,
                confirm_oversized: () => false,
            },
        );

        expect(result.commit_shas[REPOSITORY]).toBeNull();
        expect(result.fallback_patches[REPOSITORY]).toMatch(/fallback\..*\.patch$/);
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('user request'))).toBe(true);
    });

    it('honors an async confirm_oversized callback (Promise return value)', async () => {
        seed_single_repo_manifest('pl-oversize-async-decline');
        install_podman_mock_implementation(10 * 1024 * 1024);

        const result = await commit_session_to_branch(
            'pl-oversize-async-decline',
            1,
            {
                ...default_options,
                max_diff_size_bytes: 1024,
                confirm_oversized: async () => false,
            },
        );

        expect(result.fallback_patches[REPOSITORY]).toMatch(/fallback\..*\.patch$/);
    });

    it('writes a fallback and emits the branch-missing warning when the patchlab branch was deleted on the host', async () => {
        seed_single_repo_manifest('pl-no-branch');
        install_podman_mock_implementation(1024);
        mocked_patchlab_branch_exists.mockReturnValueOnce(false);

        const result = await commit_session_to_branch('pl-no-branch', 1, default_options);

        expect(result.commit_shas[REPOSITORY]).toBeNull();
        expect(result.fallback_patches[REPOSITORY]).toMatch(/fallback\..*\.patch$/);
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('no longer exists'))).toBe(true);
    });

    it('produces independent per-repository outcomes: one repository falls back while its sibling cleanly no-ops', async () => {
        const REPO_A = '/host/repo-a';
        const REPO_B = '/host/repo-b';
        seed_multi_repo_manifest('pl-multi', [REPO_A, REPO_B]);

        // Differential per-repository slice sizes, dispatched on the per-repo
        // diff temp path (which carries the disambiguated repository basename,
        // see slice_repository_diff_in_sandbox): repo-a has a real diff, repo-b
        // has none. repo-b's empty slice returns BEFORE the apply step, so this
        // exercises a genuine two-repository fan-out without the spawn path.
        mocked_execFileSync.mockImplementation(((file: string, args?: readonly string[], options?: { encoding?: BufferEncoding }) => {
            if (file !== 'podman') {
                throw new Error(`unexpected execFileSync target: ${file}`);
            }
            const arguments_list = [...(args ?? [])];
            if (arguments_list[0] === 'exec' && arguments_list.includes('stat')) {
                const probed_path = arguments_list.at(-1) ?? '';
                const size_bytes = probed_path.includes('repo-a') ? 1024 : 0;
                const text = `${size_bytes}\n`;
                return options?.encoding ? text : Buffer.from(text);
            }
            return options?.encoding ? '' : Buffer.from('');
        }) as typeof execFileSync);

        // repo-a's patchlab branch was deleted on the host (→ fallback); repo-b's
        // is intact (though its empty slice returns before the branch check).
        mocked_patchlab_branch_exists.mockImplementation((repository_root: string) => repository_root === REPO_B);

        const result = await commit_session_to_branch('pl-multi', 1, default_options);

        // The fan-out produced one entry per repository in BOTH result maps.
        const sorted = (values: string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));
        expect(sorted(Object.keys(result.commit_shas))).toEqual([REPO_A, REPO_B]);
        expect(sorted(Object.keys(result.fallback_patches))).toEqual([REPO_A, REPO_B]);

        // The outcomes are DIFFERENT and uncrossed: repo-a fell back to its own
        // disambiguated patch; repo-b committed nothing and wrote no fallback.
        expect(result.commit_shas[REPO_A]).toBeNull();
        expect(result.fallback_patches[REPO_A]).toMatch(/fallback\.repo-a\.patch$/);
        expect(result.commit_shas[REPO_B]).toBeNull();
        expect(result.fallback_patches[REPO_B]).toBeNull();

        // The branch-missing warning fired for repo-a ONLY — the per-repository
        // decision did not bleed onto the sibling.
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        const branch_missing_warnings = warnings.filter((message) => message.includes('no longer exists'));
        expect(branch_missing_warnings).toHaveLength(1);
        expect(branch_missing_warnings[0]).toContain(REPO_A);
        expect(branch_missing_warnings[0]).not.toContain(REPO_B);
    });

    it('logs a warning when advance_container_head fails but still returns the fan-out result', async () => {
        seed_single_repo_manifest('pl-advance-failure');
        const stat_marker = 'stat';
        const commit_marker = 'commit';

        mocked_execFileSync.mockImplementation(((file: string, args?: readonly string[], options?: { encoding?: BufferEncoding }) => {
            if (file !== 'podman') {
                throw new Error(`unexpected execFileSync target: ${file}`);
            }
            const arguments_set = new Set(args ?? []);
            if (arguments_set.has(stat_marker)) {
                const text = '0\n';
                return options?.encoding ? text : Buffer.from(text);
            }
            // advance_container_head invokes `git commit --allow-empty` at the
            // end of the fan-out — throw on that specific call to exercise the
            // advance-failure warning branch.
            if (arguments_set.has(commit_marker) && arguments_set.has('--allow-empty')) {
                throw new Error('container commit failed');
            }
            return options?.encoding ? '' : Buffer.from('');
        }) as typeof execFileSync);

        const result = await commit_session_to_branch('pl-advance-failure', 1, default_options);

        // Fan-out path was empty-slice — commit is null, no fallback.
        expect(result.commit_shas[REPOSITORY]).toBeNull();
        expect(result.fallback_patches[REPOSITORY]).toBeNull();
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('Container HEAD advance failed'))).toBe(true);
    });

    it('applies the DEFAULT_MAX_DIFF_BYTES value as the cap when max_diff_size_bytes is not supplied', async () => {
        seed_single_repo_manifest('pl-default-limit');
        // One byte OVER the default, with no explicit cap and no confirmation
        // hook → the orchestrator must fall back using the DEFAULT cap, and the
        // diagnostic must name that exact value. Driving the slice against the
        // real default (rather than asserting the absence of the word "cap")
        // pins the actual number: a regression that changed the default to 0,
        // or read the wrong constant, would flip this branch or print a
        // different value.
        install_podman_mock_implementation(DEFAULT_MAX_DIFF_BYTES + 1);

        const result = await commit_session_to_branch('pl-default-limit', 1, default_options);

        expect(result.commit_shas[REPOSITORY]).toBeNull();
        expect(result.fallback_patches[REPOSITORY]).toMatch(/fallback\..*\.patch$/);
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        const oversize_warning = warnings.find((message) => message.includes('exceeds'));
        expect(oversize_warning).toBeDefined();
        expect(oversize_warning).toContain(String(DEFAULT_MAX_DIFF_BYTES));
    });
});
