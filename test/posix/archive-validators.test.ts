// POSIX-only assertions for archive validators. Run via the `posix` vitest
// project (see vitest.config.ts) — typically inside a Linux container with
// `npm run test:posix`. The tests here exercise filesystem object types
// (fifos, sockets) that don't exist on Windows.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { assert_artifact_filesystem_type } from '../../src/extractable_artifact.js';

const PROVIDER = 'test-provider';

describe('assert_artifact_filesystem_type — POSIX-only filesystem object types', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-fs-check-posix-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('returns mismatch with actual=fifo for fifo objects', () => {
        const fifo_path = path.join(temporary_directory, 'fifo');
        try {
            child_process.execFileSync('mkfifo', [fifo_path]);
        } catch {
            return; // mkfifo unavailable; skip rather than fail
        }
        expect(assert_artifact_filesystem_type(fifo_path, 'file', PROVIDER, 'a'))
            .toEqual({ kind: 'mismatch', actual: 'fifo' });
    });
});
