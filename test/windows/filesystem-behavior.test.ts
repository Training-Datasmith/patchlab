// Windows-only assertions for host-aware path comparison, the atomic-write
// helper, and per-source containment — exercised against REAL win32 filesystem
// semantics (case-insensitive NTFS, MoveFileEx rename-replace) and the real
// `host_is_case_insensitive()` default, rather than the injected `case_insensitive`
// argument the platform-agnostic unit tests use.
//
// The whole suite self-gates with `process.platform === 'win32'`; on POSIX
// runners every test no-ops cleanly. These run on the `windows-latest` leg of
// the CI matrix (and locally on a Windows host via `npm test`).
//
// NOT covered here (deliberately): the documented `fs.renameSync` drop under
// concurrent same-target contention, and `safe_unlink`'s EBUSY tolerance — an
// open file handle does NOT block unlink/rename on current Node/libuv (it opens
// with FILE_SHARE_DELETE), so neither can be triggered deterministically in a
// single-process unit test. The retry LOGIC is covered platform-agnostically in
// test/unit/atomic-write-retry.test.ts via a renameSync mock.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    host_is_case_insensitive,
    is_path_within,
    paths_equal_for_host,
} from '../../src/path_containment.js';
import { atomic_write_file } from '../../src/safe_filesystem.js';
import { assert_host_path_within_source } from '../../src/tools/configured_provider/index.js';

const IS_WINDOWS = process.platform === 'win32';
const describe_on_windows = describe.runIf(IS_WINDOWS);

describe_on_windows('path_containment — real win32 case-insensitivity (default arg)', () => {
    it('reports the host as case-insensitive', () => {
        expect(host_is_case_insensitive()).toBe(true);
    });

    it('is_path_within folds case by default (the production security-check path)', () => {
        // No explicit case_insensitive argument — this is the value the real
        // call sites use. On win32 the default must fold, or a containment
        // check would falsely REJECT a legitimately-contained path that
        // differs only in case (the macOS/Windows divergence this unified).
        expect(is_path_within('C:\\Users\\Me\\Repo\\sub', 'C:\\users\\me\\repo')).toBe(true);
    });

    it('is_path_within normalizes mixed separators alongside case folding', () => {
        expect(is_path_within('C:/Users/Me/Repo/sub', 'C:\\users\\me\\repo')).toBe(true);
    });

    it('is_path_within still rejects a case-folded sibling that only shares a prefix string', () => {
        // 'C:\\repo-evil' folds equal to 'c:\\repo-evil' but is NOT under
        // 'C:\\repo' — the separator boundary must hold even when folding.
        expect(is_path_within('C:\\Repo-Evil\\file', 'C:\\repo')).toBe(false);
    });

    it('paths_equal_for_host folds case and separators by default', () => {
        expect(paths_equal_for_host('C:\\Repo', 'c:/repo/')).toBe(true);
        expect(paths_equal_for_host('C:\\Repo', 'C:\\other')).toBe(false);
    });
});

describe_on_windows('atomic_write_file — real win32 rename-replace', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-win-atomic-')),
        );
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    function leftover_tempfiles(target: string): string[] {
        const base = path.basename(target);
        return fs.readdirSync(path.dirname(target)).filter(
            (entry) => entry.startsWith(`${base}.tmp.`),
        );
    }

    it('replaces an existing file via MoveFileEx and leaves no tempfile', () => {
        // On Windows a rename onto an existing path uses MoveFileEx with
        // MOVEFILE_REPLACE_EXISTING; verify the helper publishes the new bytes
        // and cleans up the temp file on a real win32 host.
        const target = path.join(temporary_directory, 'metadata.json');
        fs.writeFileSync(target, 'stale');

        atomic_write_file(target, 'fresh');

        expect(fs.readFileSync(target, 'utf-8')).toBe('fresh');
        expect(leftover_tempfiles(target)).toEqual([]);
    });

    it('writes raw bytes for a binary payload', () => {
        const target = path.join(temporary_directory, 'binary');
        const payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

        atomic_write_file(target, payload);

        expect(fs.readFileSync(target)).toEqual(payload);
    });
});

describe_on_windows('assert_host_path_within_source — real win32 default (no injected case flag)', () => {
    let temporary_root: string;
    let source: string;

    beforeEach(() => {
        temporary_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-win-source-')));
        // A mixed-case repository directory: the case difference lives in the
        // common prefix, so the lexical containment leg must fold to match.
        source = path.join(temporary_root, 'MyRepo');
        fs.mkdirSync(path.join(source, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(temporary_root, { recursive: true, force: true });
    });

    it('accepts a contained host path that differs only in case from the source', () => {
        // Drive the REAL host_is_case_insensitive() default (no case_insensitive
        // option) plus real fs.realpathSync. The lexical leg compares the
        // path.resolve'd inputs, which retain the caller's case in the prefix,
        // so the default must fold on win32 for `myrepo` to match `MyRepo`.
        const host_file = path.join(temporary_root, 'myrepo', '.patchlab', 'tools', 'template.json');
        fs.writeFileSync(path.join(source, '.patchlab', 'tools', 'template.json'), '{}');

        const result = assert_host_path_within_source(
            host_file,
            source,
            path.join(source, '.patchlab', 'tools', 'foo.yaml'),
        );

        expect(result).toBeNull();
    });

    it('rejects a host path outside the source tree under the real default', () => {
        const result = assert_host_path_within_source(
            'C:\\Windows\\System32\\drivers\\etc\\hosts',
            source,
            path.join(source, '.patchlab', 'tools', 'foo.yaml'),
        );

        expect(result).not.toBeNull();
        expect(result?.reason).toContain('outside repository tree');
    });
});
