/**
 * Regression lock for the binary-diff UTF-8 corruption fix (findings-A cluster 4).
 *
 * `git diff --binary` output carries the raw bytes of text-classified files in
 * latin1/other non-UTF-8 encodings. Capturing that through a UTF-8 decode
 * (`run_git`'s `encoding: 'utf-8'`) replaces every invalid byte with U+FFFD,
 * which makes the host-side `git apply` reject the patch or silently writes
 * corrupted content. `run_git_capture_buffer` returns the bytes untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { run_git, run_git_capture_buffer } from '../../../src/branch/internals.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
} from '../../helpers/git_repository.js';

const LATIN1_E_ACUTE = 0xE9; // `é` in latin1 — a lone 0xE9 is NOT valid UTF-8.

describe('run_git_capture_buffer — byte-exact diff capture', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-binary-diff-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('preserves a non-UTF-8 byte that the UTF-8 string capture replaces with U+FFFD', () => {
        // A mostly-ASCII file with one latin1 high byte: git classifies it as
        // text, so `--binary` emits a normal hunk whose `+` line carries the raw
        // 0xE9 — exactly the content a UTF-8 decode destroys.
        const content = Buffer.concat([Buffer.from('cafe'), Buffer.from([LATIN1_E_ACUTE]), Buffer.from('\n')]);
        fs.writeFileSync(path.join(repository, 'latin1.txt'), content);
        execFileSync('git', ['add', '-A'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });

        const buffer_capture = run_git_capture_buffer(['diff', '--cached', '--binary'], { cwd: repository });
        const string_capture = run_git(['diff', '--cached', '--binary'], { cwd: repository });

        // The raw byte survives the Buffer capture intact...
        expect(buffer_capture.stdout.includes(LATIN1_E_ACUTE)).toBe(true);
        // ...while the legacy string capture lost it to the U+FFFD replacement char.
        expect(string_capture.stdout).toContain('�');
        expect(Buffer.from(string_capture.stdout, 'utf-8').includes(LATIN1_E_ACUTE)).toBe(false);
    });

    it('captures byte-identical output to what git wrote (round-trips through git apply cleanly)', () => {
        // Stage a latin1 file, capture the binary diff as a Buffer, then apply
        // that exact Buffer into a fresh clone and confirm the byte survives.
        const content = Buffer.concat([Buffer.from('na'), Buffer.from([LATIN1_E_ACUTE]), Buffer.from('ve\n')]);
        fs.writeFileSync(path.join(repository, 'naive.txt'), content);
        execFileSync('git', ['add', '-A'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const patch = run_git_capture_buffer(['diff', '--cached', '--binary'], { cwd: repository }).stdout;

        // Apply into a second repo seeded from the same initial commit.
        const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-binary-apply-')));
        try {
            initialize_repository_with_initial_commit(other);
            const apply_result = run_git(['apply', '--index', '-'], { cwd: other, input: patch, allow_failure: true });
            expect(apply_result.status).toBe(0);
            expect(fs.readFileSync(path.join(other, 'naive.txt')).includes(LATIN1_E_ACUTE)).toBe(true);
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });
});
