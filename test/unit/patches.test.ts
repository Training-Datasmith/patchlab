import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    create_patchlab_branch,
} from '../../src/branch/index.js';
import {
    build_archive_path,
    write_session_metadata,
    type Session_Metadata,
} from '../../src/archive.js';
import { create_manifest, write_manifest } from '../../src/manifest.js';
import {
    generate_patch,
    generate_session_patch,
    write_patch,
} from '../../src/patches.js';
import * as podman from '../../src/podman.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    resolve_revision,
} from '../helpers/git_repository.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';

// Mock podman so the four-cell matrix tests below can simulate container state
// without spinning up real containers. The pre-existing tests in this file
// don't depend on podman behaviorally — `container_running` against a
// non-existent container returns false in the mock just as it would on a real
// host with no matching container, so the cumulative-only path is unchanged.
vi.mock('../../src/podman.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/podman.js')>('../../src/podman.js');
    return {
        ...actual,
        container_running: vi.fn().mockReturnValue(false),
        exec_container: vi.fn().mockReturnValue(''),
        // The binary pending diff is captured byte-exact via this variant; the
        // string `exec_container` now only runs `git add -A` and `git reset`.
        exec_container_capture_buffer: vi.fn().mockReturnValue(Buffer.alloc(0)),
    };
});

function add_session_commit(
    repository: string,
    patchlab_id: string,
    session_number: number,
    file_path: string,
    new_content: string
): string {
    const branch = `patchlab/${patchlab_id}`;
    const branch_tip = resolve_revision(repository, `refs/heads/${branch}`);

    const temporary_index = path.join(
        os.tmpdir(),
        `patchlab-test-${patchlab_id}-${session_number}-${Date.now()}.idx`
    );
    try {
        execFileSync('git', ['read-tree', branch_tip], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
        });

        const blob_sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            input: new_content,
            encoding: 'utf-8',
        }).trim();

        execFileSync(
            'git',
            ['update-index', '--add', '--cacheinfo', `100644,${blob_sha},${file_path}`],
            {
                cwd: repository,
                env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            }
        );

        const tree_sha = execFileSync('git', ['write-tree'], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            encoding: 'utf-8',
        }).trim();

        const commit_sha = execFileSync(
            'git',
            ['commit-tree', tree_sha, '-p', branch_tip, '-m', `session ${session_number}`],
            { cwd: repository, env: GIT_TEST_ENVIRONMENT, encoding: 'utf-8' }
        ).trim();

        execFileSync('git', ['update-ref', `refs/heads/${branch}`, commit_sha], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
        });

        const metadata: Session_Metadata = {
            session_number,
            created_at: new Date().toISOString(),
            completed_at: null,
            status: 'completed',
            tool: DEFAULT_TEST_TOOL,
            container_name: null,
            commit_shas: { [repository]: commit_sha },
            fallback_patches: { [repository]: null },
            resource_limits: null,
        };
        write_session_metadata(patchlab_id, session_number, metadata);
        return commit_sha;
    } finally {
        try {
            fs.unlinkSync(temporary_index);
        } catch (_ignored) {
            /* already gone */
        }
    }
}

/**
 * Build a patchlab spanning two host repositories and write the manifest. Each
 * repository gets its own `patchlab/{id}` branch with its captured baseline /
 * creation-point SHAs recorded in the per-repository maps.
 */
function set_up_multi_repository_patchlab(
    patchlab_id: string,
    repository_a: string,
    repository_b: string,
): void {
    const archive_directory = build_archive_path(patchlab_id);
    fs.mkdirSync(archive_directory, { recursive: true });
    const branch_a = create_patchlab_branch(repository_a, patchlab_id);
    const branch_b = create_patchlab_branch(repository_b, patchlab_id);
    const manifest = create_manifest(
        patchlab_id,
        [
            { host_path: repository_a, repository_root: repository_a, source_prefix: '', mount_name: 'a' },
            { host_path: repository_b, repository_root: repository_b, source_prefix: '', mount_name: 'b' },
        ],
        'unused',
        'unused',
        {
            baseline_commit_shas: {
                [repository_a]: branch_a.baseline_sha,
                [repository_b]: branch_b.baseline_sha,
            },
            branch_creation_point_shas: {
                [repository_a]: branch_a.branch_creation_point_sha,
                [repository_b]: branch_b.branch_creation_point_sha,
            },
        },
    );
    manifest.tool = DEFAULT_TEST_TOOL;
    write_manifest(archive_directory, manifest);
}

/**
 * Add a commit to ONE repository's patchlab branch and merge the resulting
 * commit_sha into the existing session metadata's `commit_shas` map. Unlike
 * `add_session_commit` (which writes new metadata each call), this helper
 * preserves existing per-repository entries so multi-repository tests can
 * record commits in two repositories under one session.
 */
function add_commit_to_branch(
    repository: string,
    patchlab_id: string,
    file_path: string,
    new_content: string,
): string {
    const branch = `patchlab/${patchlab_id}`;
    const branch_tip = resolve_revision(repository, `refs/heads/${branch}`);

    const temporary_index = path.join(
        os.tmpdir(),
        `patchlab-test-multi-${patchlab_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.idx`,
    );
    try {
        execFileSync('git', ['read-tree', branch_tip], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
        });
        const blob_sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            input: new_content,
            encoding: 'utf-8',
        }).trim();
        execFileSync(
            'git',
            ['update-index', '--add', '--cacheinfo', `100644,${blob_sha},${file_path}`],
            { cwd: repository, env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index } },
        );
        const tree_sha = execFileSync('git', ['write-tree'], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            encoding: 'utf-8',
        }).trim();
        const commit_sha = execFileSync(
            'git',
            ['commit-tree', tree_sha, '-p', branch_tip, '-m', `multi-repo session commit in ${repository}`],
            { cwd: repository, env: GIT_TEST_ENVIRONMENT, encoding: 'utf-8' },
        ).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, commit_sha], {
            cwd: repository, env: GIT_TEST_ENVIRONMENT,
        });

        // Merge into existing session-1 metadata (write or overlay).
        const metadata_path = path.join(build_archive_path(patchlab_id), 'sessions', '1', 'metadata.json');
        let metadata: Session_Metadata;
        if (fs.existsSync(metadata_path)) {
            metadata = JSON.parse(fs.readFileSync(metadata_path, 'utf-8')) as Session_Metadata;
            metadata.commit_shas[repository] = commit_sha;
            metadata.fallback_patches[repository] = null;
        } else {
            metadata = {
                session_number: 1,
                created_at: new Date().toISOString(),
                completed_at: null,
                status: 'completed',
                tool: DEFAULT_TEST_TOOL,
                container_name: null,
                commit_shas: { [repository]: commit_sha },
                fallback_patches: { [repository]: null },
                resource_limits: null,
            };
        }
        write_session_metadata(patchlab_id, 1, metadata);
        return commit_sha;
    } finally {
        try {
            fs.unlinkSync(temporary_index);
        } catch (_ignored) {
            // already gone
        }
    }
}

/**
 * Record a session commit that REMOVES `file_path_to_remove` from the
 * patchlab branch tip. Mirrors `add_session_commit`'s shape but uses
 * `update-index --remove` so the resulting diff against the baseline has
 * `+++ /dev/null` on the destination side. Used by the deletion-shape test.
 */
function remove_in_session_commit(
    repository: string,
    patchlab_id: string,
    session_number: number,
    file_path_to_remove: string,
): string {
    const branch = `patchlab/${patchlab_id}`;
    const branch_tip = resolve_revision(repository, `refs/heads/${branch}`);

    const temporary_index = path.join(
        os.tmpdir(),
        `patchlab-test-${patchlab_id}-${session_number}-${Date.now()}.idx`,
    );
    try {
        execFileSync('git', ['read-tree', branch_tip], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
        });
        // `update-index --remove` only acts when the worktree file is
        // missing too; `--force-remove` removes from the index regardless.
        // `git rm --cached` would also work but requires `-f` plus path
        // validation; `update-index --force-remove` is the minimal verb.
        execFileSync(
            'git',
            ['update-index', '--force-remove', file_path_to_remove],
            {
                cwd: repository,
                env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            },
        );

        const tree_sha = execFileSync('git', ['write-tree'], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            encoding: 'utf-8',
        }).trim();
        const commit_sha = execFileSync(
            'git',
            ['commit-tree', tree_sha, '-p', branch_tip, '-m', `session ${session_number} (delete ${file_path_to_remove})`],
            { cwd: repository, env: GIT_TEST_ENVIRONMENT, encoding: 'utf-8' },
        ).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, commit_sha], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
        });

        const metadata: Session_Metadata = {
            session_number,
            created_at: new Date().toISOString(),
            completed_at: null,
            status: 'completed',
            tool: DEFAULT_TEST_TOOL,
            container_name: null,
            commit_shas: { [repository]: commit_sha },
            fallback_patches: { [repository]: null },
            resource_limits: null,
        };
        write_session_metadata(patchlab_id, session_number, metadata);
        return commit_sha;
    } finally {
        try {
            fs.unlinkSync(temporary_index);
        } catch (_ignored) {
            // already gone
        }
    }
}

function set_up_patchlab(repository: string, patchlab_id: string): void {
    const archive_directory = build_archive_path(patchlab_id);
    fs.mkdirSync(archive_directory, { recursive: true });
    const branch_result = create_patchlab_branch(repository, patchlab_id);
    const manifest = create_manifest(
        patchlab_id,
        [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
        'unused',
        'unused',
        {
            baseline_commit_sha: branch_result.baseline_sha,
        },
    );
    manifest.tool = DEFAULT_TEST_TOOL;
    write_manifest(archive_directory, manifest);
}

describe('patches: branch-based export', () => {
    const home_handle = install_isolated_home_hooks('patchlab-patches-home-');
    let repository: string;

    beforeEach(() => {
        register_default_test_tool();
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-patches-repo-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('generate_patch returns the cumulative diff across all session commits (4.9)', () => {
        const patchlab_id = 'pl-cumulative';
        set_up_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');
        add_session_commit(repository, patchlab_id, 2, 'b.txt', 'second\n');

        const patch = generate_patch(patchlab_id);
        expect(patch).toContain('a.txt');
        expect(patch).toContain('b.txt');
        expect(patch).toContain('first');
        expect(patch).toContain('second');
    });

    it('generate_patch with --repository matching the manifest accepts and scopes to that repo (multi-source-extraction task 6.4)', () => {
        const patchlab_id = 'pl-scoped';
        set_up_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        const patch = generate_patch(patchlab_id, { repository_root: repository });
        expect(patch).toContain('a.txt');
        expect(patch).toContain('first');
    });

    it('generate_patch with --repository not matching the manifest rejects with the patchlab repo list', () => {
        const patchlab_id = 'pl-scoped-wrong';
        set_up_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        expect(() => generate_patch(patchlab_id, { repository_root: '/does/not/match' })).toThrow(
            /is not in the patchlab's repository set/i,
        );
    });

    it('generate_patch returns empty string when there are no session commits', () => {
        const patchlab_id = 'pl-empty';
        set_up_patchlab(repository, patchlab_id);

        const patch = generate_patch(patchlab_id);
        expect(patch).toBe('');
    });

    it('generate_patch emits subdirectory file paths relative to the repository root', () => {
        // Subdirectory paths surface as `src/app.ts`, NOT as an absolute host
        // path (`/tmp/...`) and NOT as a container working-directory path
        // (`/home/patchlab/workspace/...`). Downstream `apply_patch` depends
        // on repository-relative paths; a regression that prefixed the
        // container working directory would break apply for every patch
        // emitted from a non-root file mutation.
        const patchlab_id = 'pl-subdir-paths';
        set_up_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'src/app.ts', 'const x = 1;\n');

        const patch = generate_patch(patchlab_id);
        expect(patch).toContain('src/app.ts');
        expect(patch).not.toMatch(/\/home\/patchlab/);
        expect(patch).not.toMatch(/^---\s+\/tmp/m);
        expect(patch).not.toMatch(/^\+\+\+\s+\/tmp/m);
    });

    it('generate_patch represents a deletion with /dev/null as the destination', () => {
        // The baseline carries `README.md` (written by `init_test_repository`);
        // the session removes it. `git diff` surfaces deletions with
        // `--- a/<path>` and `+++ /dev/null`. A regression that emitted
        // `+++ b/<path>` for deletions would still parse (technically) but
        // would break round-trip semantics with `apply_patch`'s deletion
        // path, which keys on the `/dev/null` marker to detect removal.
        const patchlab_id = 'pl-deletion';
        set_up_patchlab(repository, patchlab_id);
        remove_in_session_commit(repository, patchlab_id, 1, 'README.md');

        const patch = generate_patch(patchlab_id);
        expect(patch).toContain('README.md');
        expect(patch).toContain('/dev/null');
    });

    it('generate_session_patch + write_patch writes a single-session diff to file (4.10)', () => {
        const patchlab_id = 'pl-single-export';
        set_up_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');
        add_session_commit(repository, patchlab_id, 2, 'b.txt', 'second\n');

        const session_two_patch = generate_session_patch(patchlab_id, 2);
        expect(session_two_patch).toContain('b.txt');
        expect(session_two_patch).toContain('second');
        expect(session_two_patch).not.toContain('a.txt');

        const output_path = path.join(home_handle.current(), 'session-2.patch');
        const written = write_patch(session_two_patch, output_path);
        expect(written).toBe(output_path);
        expect(fs.readFileSync(output_path, 'utf-8')).toBe(session_two_patch);
    });

    it('generate_session_patch returns empty string for sessions with null commit_sha', () => {
        const patchlab_id = 'pl-null-export';
        set_up_patchlab(repository, patchlab_id);
        const metadata: Session_Metadata = {
            session_number: 1,
            created_at: new Date().toISOString(),
            completed_at: null,
            status: 'completed',
            tool: DEFAULT_TEST_TOOL,
            container_name: null,
            commit_shas: { [repository]: null },
            fallback_patches: { [repository]: null },
            resource_limits: null,
        };
        write_session_metadata(patchlab_id, 1, metadata);

        const patch = generate_session_patch(patchlab_id, 1);
        expect(patch).toBe('');
    });

    it('write_patch returns the patch unchanged when no output_path is given', () => {
        const patch = '--- a/file\n+++ b/file\n';
        expect(write_patch(patch)).toBe(patch);
    });

    it('generate_session_patch throws when session metadata is missing', () => {
        // The metadata-missing branch is a defensive guard against a stale
        // session number (e.g. the user requested session 99 but only 1
        // exists). A regression that silently returned `''` would let the
        // operator believe the requested session had no changes when in
        // fact it doesn't exist at all.
        const patchlab_id = 'pl-missing-metadata';
        set_up_patchlab(repository, patchlab_id);

        expect(() => generate_session_patch(patchlab_id, 99))
            .toThrow(/No metadata found for session 99/);
    });

    it('generate_patch on a multi-repository patchlab without --repository emits one diff per repo with comment-style separators (task 6.4)', () => {
        const patchlab_id = 'pl-multi-repo';
        // Set up a second host repository.
        const repository_b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-patches-repo-b-')));
        try {
            initialize_repository_with_initial_commit(repository_b);
            set_up_multi_repository_patchlab(patchlab_id, repository, repository_b);
            add_commit_to_branch(repository, patchlab_id, 'a-file.txt', 'a content\n');
            add_commit_to_branch(repository_b, patchlab_id, 'b-file.txt', 'b content\n');

            const patch = generate_patch(patchlab_id);

            // Both repositories' separators appear, in manifest_repositories order
            // (which is first-appearance order: repository, then repository_b).
            expect(patch).toContain(`# === Patch for ${repository} ===`);
            expect(patch).toContain(`# === Patch for ${repository_b} ===`);
            const separator_a_index = patch.indexOf(`# === Patch for ${repository} ===`);
            const separator_b_index = patch.indexOf(`# === Patch for ${repository_b} ===`);
            expect(separator_a_index).toBeGreaterThanOrEqual(0);
            expect(separator_b_index).toBeGreaterThan(separator_a_index);
            // Each repository's diff content sits between its separator and the
            // next.
            expect(patch).toContain('a-file.txt');
            expect(patch).toContain('b-file.txt');
        } finally {
            fs.rmSync(repository_b, { recursive: true, force: true });
        }
    });

    it('generate_patch on a multi-repository patchlab with --repository scopes to one repository (task 6.4)', () => {
        const patchlab_id = 'pl-multi-repo-scoped';
        const repository_b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-patches-repo-b-')));
        try {
            initialize_repository_with_initial_commit(repository_b);
            set_up_multi_repository_patchlab(patchlab_id, repository, repository_b);
            add_commit_to_branch(repository, patchlab_id, 'a-file.txt', 'a content\n');
            add_commit_to_branch(repository_b, patchlab_id, 'b-file.txt', 'b content\n');

            const patch = generate_patch(patchlab_id, { repository_root: repository_b });

            // Scoped output: no separators (single-repository form), and
            // only repository_b's content.
            expect(patch).not.toContain('# === Patch for');
            expect(patch).toContain('b-file.txt');
            expect(patch).not.toContain('a-file.txt');
        } finally {
            fs.rmSync(repository_b, { recursive: true, force: true });
        }
    });

    describe('generate_patch composes committed + pending into a single coherent diff (4-cell matrix)', () => {
        // Each "pending" mock value is a real `git diff --cached HEAD` output
        // computed from the test repo against the patchlab branch tip — so the
        // host-side `compose_diff_against_baseline_with_pending` worktree+apply
        // sees a syntactically valid, applicable patch (matching what a live
        // container's git would actually emit).
        function build_pending_diff_for_new_file(
            patchlab_id: string,
            file_path: string,
            content: string
        ): string {
            const branch_reference = `refs/heads/patchlab/${patchlab_id}`;
            const tip = execFileSync('git', ['rev-parse', branch_reference], {
                cwd: repository,
                env: GIT_TEST_ENVIRONMENT,
                encoding: 'utf-8',
            }).trim();

            const temporary_index = path.join(
                os.tmpdir(),
                `patchlab-test-pending-${patchlab_id}-${Date.now()}.idx`
            );
            try {
                execFileSync('git', ['read-tree', tip], {
                    cwd: repository,
                    env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
                });
                const blob_sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
                    cwd: repository,
                    env: GIT_TEST_ENVIRONMENT,
                    input: content,
                    encoding: 'utf-8',
                }).trim();
                execFileSync(
                    'git',
                    ['update-index', '--add', '--cacheinfo', `100644,${blob_sha},${file_path}`],
                    {
                        cwd: repository,
                        env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
                    }
                );
                return execFileSync('git', ['diff', '--cached', tip], {
                    cwd: repository,
                    env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
                    encoding: 'utf-8',
                });
            } finally {
                try {
                    fs.unlinkSync(temporary_index);
                } catch (_ignored) {
                    // gone
                }
            }
        }

        beforeEach(() => {
            vi.mocked(podman.container_running).mockReset().mockReturnValue(false);
            vi.mocked(podman.exec_container).mockReset().mockReturnValue('');
            vi.mocked(podman.exec_container_capture_buffer).mockReset().mockReturnValue(Buffer.alloc(0));
        });

        it('committed empty + pending empty → empty string', () => {
            const patchlab_id = 'pl-empty-empty';
            set_up_patchlab(repository, patchlab_id);
            // container_running defaults to false → no pending diff is read.

            const patch = generate_patch(patchlab_id);
            expect(patch).toBe('');
        });

        it('committed empty + pending non-empty → diff covering pending only (fresh sandbox case)', () => {
            const patchlab_id = 'pl-empty-pending';
            set_up_patchlab(repository, patchlab_id);

            const pending_diff = build_pending_diff_for_new_file(
                patchlab_id,
                'pending.txt',
                'pending change\n'
            );

            vi.mocked(podman.container_running).mockReturnValue(true);
            // git add -A / git reset go through exec_container (default ''); the
            // binary diff is captured byte-exact via exec_container_capture_buffer.
            vi.mocked(podman.exec_container_capture_buffer).mockReturnValue(Buffer.from(pending_diff, 'utf-8'));

            const patch = generate_patch(patchlab_id);
            expect(patch).toContain('pending.txt');
            expect(patch).toContain('pending change');
        });

        it('committed non-empty + pending empty → committed only (post-session-exit case)', () => {
            const patchlab_id = 'pl-committed-empty';
            set_up_patchlab(repository, patchlab_id);
            add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

            // container_running defaults to false → no pending diff is read.

            const patch = generate_patch(patchlab_id);
            expect(patch).toContain('a.txt');
            expect(patch).toContain('first');
            expect(patch).not.toContain('pending change');
        });

        it('committed non-empty + pending non-empty → single coherent diff covering both', () => {
            const patchlab_id = 'pl-committed-pending';
            set_up_patchlab(repository, patchlab_id);
            add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

            const pending_diff = build_pending_diff_for_new_file(
                patchlab_id,
                'pending.txt',
                'pending change\n'
            );

            vi.mocked(podman.container_running).mockReturnValue(true);
            vi.mocked(podman.exec_container_capture_buffer).mockReturnValue(Buffer.from(pending_diff, 'utf-8'));

            const patch = generate_patch(patchlab_id);
            expect(patch).toContain('a.txt');
            expect(patch).toContain('first');
            expect(patch).toContain('pending.txt');
            expect(patch).toContain('pending change');
            // a.txt sorts before pending.txt — git diff orders files alphabetically,
            // so 'first' (in a.txt) appears before 'pending change' (in pending.txt).
            expect(patch.indexOf('first')).toBeLessThan(patch.indexOf('pending change'));
            // The result is ONE diff rendering, not two concatenated. Headers
            // for both files are present, but no second baseline-comparison
            // header repeats the same path.
            const a_txt_header_count = (patch.match(/^diff --git a\/a\.txt b\/a\.txt$/gm) ?? []).length;
            const pending_header_count = (patch.match(/^diff --git a\/pending\.txt b\/pending\.txt$/gm) ?? []).length;
            expect(a_txt_header_count).toBe(1);
            expect(pending_header_count).toBe(1);
        });

        it('container running with whitespace-only diff is treated as empty pending', () => {
            // `read_container_pending_diff` trims the captured diff (via a
            // lossless latin1 view) and returns an empty Buffer when the trimmed
            // result is empty — guards against `git diff` emitting an empty
            // trailing newline that would otherwise drive us down the
            // worktree-apply path with a no-op patch.
            const patchlab_id = 'pl-whitespace-pending';
            set_up_patchlab(repository, patchlab_id);
            add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

            vi.mocked(podman.container_running).mockReturnValue(true);
            vi.mocked(podman.exec_container_capture_buffer).mockReturnValue(Buffer.from('  \n', 'utf-8'));

            const patch = generate_patch(patchlab_id);
            expect(patch).toContain('a.txt');
            expect(patch).toContain('first');
            // No worktree-apply was triggered; the result is the cumulative diff
            // unchanged from the committed-only path.
            expect(patch).not.toContain('pending change');
        });

        it('reset failure during pending capture is swallowed; the captured diff still drives composition', () => {
            const patchlab_id = 'pl-reset-fails';
            set_up_patchlab(repository, patchlab_id);
            add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

            const pending_diff = build_pending_diff_for_new_file(
                patchlab_id,
                'pending.txt',
                'pending change\n'
            );

            vi.mocked(podman.container_running).mockReturnValue(true);
            vi.mocked(podman.exec_container_capture_buffer).mockReturnValue(Buffer.from(pending_diff, 'utf-8'));
            vi.mocked(podman.exec_container)
                .mockReturnValueOnce('')                                                          // git add -A
                .mockImplementationOnce(() => { throw new Error('container died mid-reset'); }); // git reset

            // Reset failure is best-effort — the pending diff was already captured
            // before reset ran, so generate_patch proceeds to compose successfully.
            const patch = generate_patch(patchlab_id);
            expect(patch).toContain('first');
            expect(patch).toContain('pending change');
        });
    });
});
