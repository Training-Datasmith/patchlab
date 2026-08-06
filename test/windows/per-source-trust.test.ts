// Windows-only counterpart to the realpath-keying trust-marker test in
// test/unit/tools/configured_provider/per-source-trust.test.ts ("two paths with
// the same realpath share a marker"), which skips on win32 because POSIX
// symlinks need admin there. NTFS directory junctions — created WITHOUT admin
// via `mklink /J` — give the same realpath-aliasing shape, so this pins the
// load-bearing property on the project's primary (Windows) dev platform: a
// marker written under one spelling of a repository path gates a differently-
// spelled junction alias of the SAME repository (and, conversely, cannot be
// dodged by addressing the repo through an alias).
//
// The whole suite self-gates with `process.platform === 'win32'`; on POSIX
// runners every test no-ops cleanly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    read_trust_marker,
    write_trust_marker,
} from '../../src/tools/configured_provider/trust_marker.js';

const IS_WINDOWS = process.platform === 'win32';
const describe_on_windows = describe.runIf(IS_WINDOWS);

function create_directory_junction(link_path: string, target_path: string): void {
    // `mklink /J` creates an NTFS directory junction. Junctions, unlike
    // symbolic links, do not require admin privileges or Developer Mode on any
    // supported Windows version. The target MUST be an existing directory
    // (absolute path); the link path MUST NOT already exist.
    execFileSync('cmd', ['/c', 'mklink', '/J', link_path, target_path], {
        stdio: 'pipe',
    });
}

describe_on_windows('trust marker — realpath-based keying via NTFS junction (task 6.20)', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-realpath-win-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-realpath-win-repo-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('two junction-aliased paths with the same realpath share a marker', () => {
        const junction_path = path.join(os.tmpdir(), `patchlab-realpath-win-junction-${Date.now()}`);
        create_directory_junction(junction_path, repository_root);
        const shared_hash = 'shared'.padEnd(64, 'a');
        try {
            // Write keyed on the real path; read keyed on the junction alias.
            // Both resolve through fs.realpathSync to the same repository_root,
            // so trust_marker_key produces the same SHA and the read hits the
            // marker the write produced.
            write_trust_marker(repository_root, shared_hash);
            expect(read_trust_marker(junction_path)).toBe(shared_hash);
        } finally {
            // Remove only the junction reparse point: fs.rmSync treats a
            // junction as a link and unlinks it without recursing into the
            // target (repository_root is cleaned separately in afterEach).
            fs.rmSync(junction_path, { recursive: true, force: true });
        }
    });
});
