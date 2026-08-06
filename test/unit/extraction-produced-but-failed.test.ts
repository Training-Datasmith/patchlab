/**
 * Locks the "produced but lost" signal that `extract_conversation` returns
 * when an artifact's container path exists (i.e., the tool produced output)
 * but the host-side copy fails (permissions, disk full, partial copy, etc.).
 * That signal flips the session status to `interrupted` — silently losing
 * the failure would leave the session marked `completed` with missing data.
 *
 * Mocks `exec_container` (the underlying call from `container_path_exists`)
 * to report the path as present (`'present'`), absent (`'absent'`), or — by
 * throwing — an exec/podman failure, then makes `copy_from_container` throw to
 * exercise the failure-during-copy branch. The probe now returns a present/
 * absent marker on exit 0 and only throws on a genuine exec failure, so a
 * missing artifact ('absent') and an unknowable one (throw) are distinct.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { mock_exec_container, mock_copy_from_container } = vi.hoisted(() => ({
    mock_exec_container: vi.fn<(name: string, command: string[]) => string>(),
    mock_copy_from_container: vi.fn<(name: string, container_path: string, host_path: string) => void>(),
}));

vi.mock('../../src/podman.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/podman.js')>();
    return {
        ...original,
        exec_container: mock_exec_container,
        copy_from_container: mock_copy_from_container,
    };
});

import { extract_conversation } from '../../src/extraction.js';
import type { Tool_Provider } from '../../src/tools/types.js';
import type { Extractable_Artifact } from '../../src/extractable_artifact.js';
import { build_archive_path } from '../../src/archive.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

function make_stub_provider(artifacts: Extractable_Artifact[]): Tool_Provider {
    return {
        name: 'stub-tool',
        get_extractable_artifacts: () => artifacts,
    } as unknown as Tool_Provider;
}

describe('extract_conversation — produced_but_failed signal', () => {
    install_isolated_home_hooks('patchlab-extract-failed-');

    const PATCHLAB_ID = 'pl-extract-failed';
    const SESSION_NUMBER = 1;

    beforeEach(() => {
        fs.mkdirSync(build_archive_path(PATCHLAB_ID), { recursive: true });
        mock_exec_container.mockReset();
        mock_copy_from_container.mockReset();
    });

    it('reports an artifact whose container path exists but copy fails as produced_but_failed', () => {
        mock_exec_container.mockReturnValue('present'); // container_path_exists → true
        mock_copy_from_container.mockImplementation(() => {
            throw new Error('podman cp failed: permission denied');
        });

        const provider = make_stub_provider([{
            name: 'conversation',
            container_path: '/home/patchlab/.tool/conversation.jsonl',
            type: 'file',
            archive_subpath: 'conversation.jsonl',
            required_for_resume: false,
        }]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        expect(result.produced_but_failed).toEqual(['conversation']);
        expect(result.extracted).toEqual([]);
        expect(result.skipped_invalid).toEqual([]);
    });

    it('splits results when one artifact copies successfully and another fails', () => {
        mock_exec_container.mockReturnValue('present'); // both paths exist
        mock_copy_from_container.mockImplementation((_name, container_path, host_path) => {
            if (container_path.endsWith('breaks.jsonl')) {
                throw new Error('podman cp failed: I/O error');
            }
            // Materialize the destination so the post-write type check passes.
            fs.mkdirSync(path.dirname(host_path), { recursive: true });
            fs.writeFileSync(host_path, 'ok');
        });

        const provider = make_stub_provider([
            {
                name: 'good',
                container_path: '/home/patchlab/.tool/good.jsonl',
                type: 'file',
                archive_subpath: 'good.jsonl',
                required_for_resume: false,
            },
            {
                name: 'bad',
                container_path: '/home/patchlab/.tool/breaks.jsonl',
                type: 'file',
                archive_subpath: 'bad.jsonl',
                required_for_resume: false,
            },
        ]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        expect(result.produced_but_failed).toEqual(['bad']);
        expect(result.extracted).toEqual(['good']);
    });

    it('does NOT mark as produced_but_failed when the container path is absent (never-produced)', () => {
        // A missing path is a normal exit-0 probe returning 'absent' — NOT an
        // exec failure. It must be skipped silently, not counted as data loss.
        mock_exec_container.mockReturnValue('absent');

        const provider = make_stub_provider([{
            name: 'conversation',
            container_path: '/home/patchlab/.tool/conversation.jsonl',
            type: 'file',
            archive_subpath: 'conversation.jsonl',
            required_for_resume: false,
        }]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        expect(result.produced_but_failed).toEqual([]);
        expect(result.extracted).toEqual([]);
        expect(result.skipped_invalid).toEqual([]);
        expect(mock_copy_from_container).not.toHaveBeenCalled();
    });

    it('marks an artifact as produced_but_failed when the existence probe itself fails (unknowable, not absent)', () => {
        // A podman/exec failure during the probe (container gone, daemon down)
        // is distinct from a clean 'absent': we cannot prove the artifact was
        // never produced, so it must be recorded as produced_but_failed (which
        // forces the session to `interrupted`) rather than silently dropped.
        mock_exec_container.mockImplementation(() => {
            throw new Error('podman exec failed: container is not running');
        });

        const provider = make_stub_provider([{
            name: 'conversation',
            container_path: '/home/patchlab/.tool/conversation.jsonl',
            type: 'file',
            archive_subpath: 'conversation.jsonl',
            required_for_resume: false,
        }]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        expect(result.produced_but_failed).toEqual(['conversation']);
        expect(result.extracted).toEqual([]);
        expect(result.skipped_invalid).toEqual([]);
        expect(mock_copy_from_container).not.toHaveBeenCalled();
    });
});

/**
 * Companion locks for the THREE host-side validation branches that route to
 * `skipped_invalid` (distinct from `produced_but_failed` because the
 * rejection happens BEFORE — or independently of — the container path being
 * consulted; it's a provider-declaration bug, not a lost-data signal, so
 * the session is NOT marked `interrupted`):
 *
 *   1. Duplicate `archive_subpath` across artifacts (case-insensitive).
 *      Both members of a duplicate pair land in `skipped_invalid`.
 *   2. Invalid `archive_subpath` (path separators, `..`, control chars, etc.).
 *      Rejection happens in `validate_archive_subpath`.
 *   3. Post-write filesystem-type mismatch (declared `type: 'file'` but
 *      the host destination is actually a directory, or vice versa).
 *      Rejection happens after copy completes.
 *
 * Each branch exists in production code but had no end-to-end witness
 * before this file.
 */
describe('extract_conversation — skipped_invalid branches', () => {
    install_isolated_home_hooks('patchlab-extract-skipped-');

    const PATCHLAB_ID = 'pl-extract-skipped';
    const SESSION_NUMBER = 1;

    beforeEach(() => {
        fs.mkdirSync(build_archive_path(PATCHLAB_ID), { recursive: true });
        mock_exec_container.mockReset();
        mock_copy_from_container.mockReset();
        // Default: every container_path_exists check passes so we can reach
        // post-copy validation paths. Tests can override per-call.
        mock_exec_container.mockReturnValue('present');
    });

    afterEach(() => {
    });

    it('marks both members of a duplicate-archive_subpath pair as skipped_invalid', () => {
        // Two artifacts share `conversation.jsonl`. ALL artifacts that share
        // a duplicated subpath are skipped (case-insensitive comparison per
        // the docstring on `collect_duplicate_subpath_names`). A third
        // artifact with a unique subpath proceeds normally — locks the
        // "rejection is scoped to the duplicate" invariant.
        mock_copy_from_container.mockImplementation((_name, _container_path, host_path) => {
            fs.mkdirSync(path.dirname(host_path), { recursive: true });
            fs.writeFileSync(host_path, 'ok');
        });

        const provider = make_stub_provider([
            {
                name: 'conversation-a',
                container_path: '/home/patchlab/.tool/conv-a.jsonl',
                type: 'file',
                archive_subpath: 'conversation.jsonl',
                required_for_resume: false,
            },
            {
                name: 'conversation-b',
                container_path: '/home/patchlab/.tool/conv-b.jsonl',
                type: 'file',
                archive_subpath: 'Conversation.JSONL',  // case-insensitive collision
                required_for_resume: false,
            },
            {
                name: 'logs',
                container_path: '/home/patchlab/.tool/logs.txt',
                type: 'file',
                archive_subpath: 'logs.txt',
                required_for_resume: false,
            },
        ]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        // Both members of the collision dropped to skipped_invalid; the
        // unrelated `logs` artifact proceeded as normal. Use arrayContaining
        // + length to assert membership without depending on iteration order.
        expect(result.skipped_invalid).toHaveLength(2);
        expect(result.skipped_invalid).toEqual(
            expect.arrayContaining(['conversation-a', 'conversation-b']),
        );
        expect(result.extracted).toEqual(['logs']);
        expect(result.produced_but_failed).toEqual([]);
    });

    it('marks an artifact with an invalid archive_subpath as skipped_invalid (no copy attempted)', () => {
        // `nested/path.jsonl` contains a separator — `validate_archive_subpath`
        // rejects it before any copy. The unrelated `good` artifact still
        // copies normally.
        mock_copy_from_container.mockImplementation((_name, _container_path, host_path) => {
            fs.mkdirSync(path.dirname(host_path), { recursive: true });
            fs.writeFileSync(host_path, 'ok');
        });

        const provider = make_stub_provider([
            {
                name: 'bad-subpath',
                container_path: '/home/patchlab/.tool/bad.jsonl',
                type: 'file',
                archive_subpath: 'nested/path.jsonl',  // separator — invalid
                required_for_resume: false,
            },
            {
                name: 'good',
                container_path: '/home/patchlab/.tool/good.jsonl',
                type: 'file',
                archive_subpath: 'good.jsonl',
                required_for_resume: false,
            },
        ]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        expect(result.skipped_invalid).toEqual(['bad-subpath']);
        expect(result.extracted).toEqual(['good']);
        expect(result.produced_but_failed).toEqual([]);
        // copy_from_container was NOT called for the bad-subpath artifact —
        // the validator short-circuits before the copy attempt.
        const invocations = mock_copy_from_container.mock.calls.map((call) => call[1]);
        expect(invocations).not.toContain('/home/patchlab/.tool/bad.jsonl');
    });

    it('marks a post-write type mismatch as skipped_invalid (declared file, materialized directory)', () => {
        // Declared `type: 'file'`, but copy_from_container materializes a
        // directory at the destination (simulating a regression where the
        // provider declared the wrong type, or podman cp surfaced something
        // unexpected). `post_write_type_matches` rejects after the copy.
        mock_copy_from_container.mockImplementation((_name, container_path, host_path) => {
            if (container_path.endsWith('mismatched.jsonl')) {
                // Materialize a directory where a file was declared.
                fs.mkdirSync(host_path, { recursive: true });
            } else {
                fs.mkdirSync(path.dirname(host_path), { recursive: true });
                fs.writeFileSync(host_path, 'ok');
            }
        });

        const provider = make_stub_provider([
            {
                name: 'type-mismatch',
                container_path: '/home/patchlab/.tool/mismatched.jsonl',
                type: 'file',  // declared file
                archive_subpath: 'mismatched.jsonl',
                required_for_resume: false,
            },
            {
                name: 'good',
                container_path: '/home/patchlab/.tool/good.jsonl',
                type: 'file',
                archive_subpath: 'good.jsonl',
                required_for_resume: false,
            },
        ]);

        const result = extract_conversation('container', provider, PATCHLAB_ID, SESSION_NUMBER);

        expect(result.skipped_invalid).toEqual(['type-mismatch']);
        expect(result.extracted).toEqual(['good']);
        expect(result.produced_but_failed).toEqual([]);
    });
});
