// POSIX-only assertions for configured_provider discovery. Run via the
// `posix` vitest project (see vitest.config.ts) — typically inside a Linux
// container with `npm run test:posix`. The tests here exercise filesystem
// behaviour that Windows blocks: case-sensitive `.YAML` vs `.yaml` and
// unprivileged symlink creation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    discover_per_source_manifest_paths,
    read_and_parse_manifest,
    type Configured_Tool_Provider_Manifest,
    type Manifest_Parse_Error,
} from '../../src/tools/configured_provider/index.js';

function is_error(
    result: Configured_Tool_Provider_Manifest | Manifest_Parse_Error
): result is Manifest_Parse_Error {
    return 'field_path' in result && 'reason' in result;
}

describe('discovery — POSIX-only filesystem behaviour', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-discovery-posix-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('skips uppercase YAML extension on case-sensitive filesystems', () => {
        // On Windows NTFS, `.YAML` and `.yaml` collide as the same on-disk
        // entry, so the assertion only makes sense on a case-sensitive fs.
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        fs.mkdirSync(tools_directory, { recursive: true });
        fs.writeFileSync(path.join(tools_directory, 'aider.YAML'), '');
        fs.writeFileSync(path.join(tools_directory, 'aider.yaml'), '');
        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p))).toEqual(['aider.yaml']);
    });

    it('follows a symlink to a regular file', () => {
        // Windows requires elevation or Developer Mode for unprivileged
        // symlink creation; POSIX permits it for any user.
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        const target_directory = path.join(temporary_directory, 'targets');
        fs.mkdirSync(tools_directory, { recursive: true });
        fs.mkdirSync(target_directory, { recursive: true });
        const target_file = path.join(target_directory, 'real.yaml');
        fs.writeFileSync(target_file, '');
        fs.symlinkSync(target_file, path.join(tools_directory, 'linked.yaml'));
        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p))).toEqual(['linked.yaml']);
    });

    it('skips a broken symlink (statSync throws → safe_stat_kind returns "other")', () => {
        // Broken symlinks hit the catch branch in `safe_stat_kind` (statSync
        // raises ENOENT on the missing target). The function swallows the
        // error and returns 'other', which `discover_manifest_paths` filters.
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        fs.mkdirSync(tools_directory, { recursive: true });
        fs.writeFileSync(path.join(tools_directory, 'real.yaml'), '');
        fs.symlinkSync(
            path.join(temporary_directory, 'does-not-exist'),
            path.join(tools_directory, 'broken.yaml'),
        );
        const paths = discover_per_source_manifest_paths(temporary_directory);
        // Only the real file survives; the broken symlink is silently skipped.
        expect(paths.map((p) => path.basename(p))).toEqual(['real.yaml']);
    });

    it('skips a symlink that points to a directory (safe_stat_kind returns "directory")', () => {
        // Symlinks-to-directories exercise the `stats.isDirectory()` branch
        // of `safe_stat_kind`. The discovery filter only keeps 'file' entries,
        // so a symlinked directory must be excluded even with a .yaml suffix.
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        const target_directory = path.join(temporary_directory, 'subdirectory');
        fs.mkdirSync(tools_directory, { recursive: true });
        fs.mkdirSync(target_directory, { recursive: true });
        fs.writeFileSync(path.join(tools_directory, 'real.yaml'), '');
        fs.symlinkSync(target_directory, path.join(tools_directory, 'linked-directory.yaml'));
        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p))).toEqual(['real.yaml']);
    });

    it('handles EACCES with a per-file Manifest_Parse_Error', () => {
        // Windows chmod doesn't translate to EACCES; verify the real
        // permission-denied path on Linux instead.
        const filename = path.join(temporary_directory, 'restricted.yaml');
        fs.writeFileSync(filename, 'name: aider\n');
        fs.chmodSync(filename, 0o000);
        try {
            const result = read_and_parse_manifest(filename);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.manifest_path).toBe(filename);
            expect(result.field_path).toBe('');
            expect(result.reason).toMatch(/cannot read|EACCES|permission/i);
        } finally {
            // Restore read access so the afterEach rmSync can unlink the file.
            // Mode 0o644 (rw-r--r--) on a test fixture inside an mkdtempSync
            // temporary directory is safe — the directory is destroyed
            // immediately afterwards.
            fs.chmodSync(filename, 0o644); // NOSONAR(S2612): test fixture cleanup.
        }
    });
});
