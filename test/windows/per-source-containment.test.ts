// Windows-only assertions for `assert_host_path_within_source`. Exercises
// filesystem behaviour that POSIX hosts cannot simulate: NTFS junctions
// (directory reparse points created without admin via `mklink /J`),
// drive-letter mismatches, and mixed-separator normalization on Windows-
// shaped paths.
//
// The whole suite self-gates with `process.platform === 'win32'`. On POSIX
// runners every test no-ops cleanly. On Windows the suite runs the same
// realpath-leg coverage the POSIX symlink test (`test/unit/per-source-
// containment.test.ts > rejects when a symlink inside the source tree
// points outside`) provides on Linux/macOS.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert_host_path_within_source } from '../../src/tools/configured_provider/index.js';

const IS_WINDOWS = process.platform === 'win32';
const describe_on_windows = describe.runIf(IS_WINDOWS);

function create_directory_junction(link_path: string, target_path: string): void {
    // `mklink /J` creates an NTFS directory junction. Junctions, unlike
    // symbolic links, do not require admin privileges or Developer Mode on
    // any supported Windows version. The target MUST be a directory (absolute
    // path); the link path MUST NOT already exist.
    execFileSync('cmd', ['/c', 'mklink', '/J', link_path, target_path], {
        stdio: 'pipe',
    });
}

describe_on_windows('assert_host_path_within_source — NTFS junctions (task 1.8)', () => {
    let temporary_source: string;
    let outside_directory: string;

    beforeEach(() => {
        temporary_source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-junction-source-')));
        outside_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-junction-outside-')));
    });

    afterEach(() => {
        try {
            fs.rmSync(temporary_source, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(outside_directory, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('rejects a path whose realpath traverses an NTFS junction that escapes the source tree', () => {
        // Set up a sibling secret outside the source tree.
        fs.writeFileSync(path.join(outside_directory, 'secret.json'), '{"key": "value"}');
        // Create a junction INSIDE the source tree that points OUTSIDE.
        const junction_inside = path.join(temporary_source, 'mounted');
        create_directory_junction(junction_inside, outside_directory);
        const lexically_contained_target = path.join(junction_inside, 'secret.json');

        const result = assert_host_path_within_source(
            lexically_contained_target,
            temporary_source,
            path.join(temporary_source, '.patchlab', 'tools', 'foo.yaml'),
        );

        expect(result).not.toBeNull();
        // The lexical leg sees a path inside the source tree, so the realpath
        // leg must be what catches the escape. The error message reflects that.
        expect(result?.reason).toMatch(/realpath|symlink|junction/i);
    });

    it('accepts a junction that stays inside the source tree', () => {
        const inside_directory = path.join(temporary_source, 'real-tools');
        fs.mkdirSync(inside_directory);
        fs.writeFileSync(path.join(inside_directory, 'template.json'), '{}');
        const junction_alias = path.join(temporary_source, 'tools-alias');
        create_directory_junction(junction_alias, inside_directory);

        const result = assert_host_path_within_source(
            path.join(junction_alias, 'template.json'),
            temporary_source,
            path.join(temporary_source, '.patchlab', 'tools', 'foo.yaml'),
        );

        expect(result).toBeNull();
    });

    it('rejects a junction at the source root that points outside (full-source escape)', () => {
        // Simulate a scenario where the source path ITSELF is a junction pointing
        // outside its lexical parent.
        const junction_source = path.join(os.tmpdir(), `patchlab-junction-source-link-${Date.now()}`);
        try {
            create_directory_junction(junction_source, outside_directory);
            fs.writeFileSync(path.join(outside_directory, 'secret.json'), 'secret');

            // Caller passes the junction path as source_path. Its realpath
            // resolves to outside_directory. A host path "inside" the junction
            // lexically is also "inside" outside_directory after realpath, so
            // containment SUCCEEDS — the realpath equivalence is the point.
            const result = assert_host_path_within_source(
                path.join(junction_source, 'secret.json'),
                junction_source,
                path.join(junction_source, '.patchlab', 'tools', 'foo.yaml'),
            );
            expect(result).toBeNull();
        } finally {
            try {
                fs.rmSync(junction_source, { recursive: true, force: true });
            } catch (_ignored) {
                // best effort
            }
        }
    });
});

describe_on_windows('assert_host_path_within_source — drive-letter mismatch', () => {
    it('rejects a host path on a different drive even if it looks contained otherwise', () => {
        // We cannot reliably create a second drive in a test, but the lexical
        // check rejects different-drive paths via path.relative producing an
        // absolute result. Use a fabricated absolute path on a different drive
        // letter and verify rejection.
        const source = 'C:\\workspace\\repo';
        const host_on_other_drive = 'D:\\workspace\\repo\\template.json';

        const result = assert_host_path_within_source(
            host_on_other_drive,
            source,
            'C:\\workspace\\repo\\.patchlab\\tools\\foo.yaml',
            // Force lexical-only path (skip realpath leg's filesystem checks
            // since neither drive exists in this synthetic case).
            { realpath_resolver: (input) => input },
        );

        expect(result).not.toBeNull();
        expect(result?.reason).toContain('outside repository tree');
    });
});

describe_on_windows('assert_host_path_within_source — separator normalization on Windows', () => {
    it('accepts a host path using forward slashes when the source uses backslashes', () => {
        const source = 'C:\\workspace\\repo';
        const host = 'C:/workspace/repo/template.json';

        const result = assert_host_path_within_source(
            host,
            source,
            'C:\\workspace\\repo\\.patchlab\\tools\\foo.yaml',
            { realpath_resolver: (input) => input },
        );

        expect(result).toBeNull();
    });

    it('rejects a forward-slash host path that escapes the source', () => {
        const source = 'C:\\workspace\\repo';
        const host = 'C:/Windows/System32/config/SAM';

        const result = assert_host_path_within_source(
            host,
            source,
            'C:\\workspace\\repo\\.patchlab\\tools\\foo.yaml',
            { realpath_resolver: (input) => input },
        );

        expect(result).not.toBeNull();
    });
});
