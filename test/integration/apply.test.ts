import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { destroy_sandbox } from '../../src/sandbox/index.js';
import { generate_patch } from '../../src/patches.js';
import { apply_patch } from '../../src/apply.js';
import { exec_container } from '../../src/container_runtime.js';

describe('patch application', () => {
    let source_directory: string;
    let target_directory: string;
    let sandbox_id: string;
    let container_name: string;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeEach(async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-src-'));
        target_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-target-'));

        // Patchlab requires the source to be a git repo with a clean working tree
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });

        fs.writeFileSync(path.join(source_directory, 'a.txt'), 'line 1\nline 2\n');
        fs.writeFileSync(path.join(source_directory, 'b.txt'), 'hello\n');

        execFileSync('git', ['add', '-A'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
            cwd: source_directory, stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });

        // Target starts same as source
        fs.writeFileSync(path.join(target_directory, 'a.txt'), 'line 1\nline 2\n');
        fs.writeFileSync(path.join(target_directory, 'b.txt'), 'hello\n');

        // Initialize target as a git repo (git apply works best in a git context)
        execFileSync('git', ['init'], { cwd: target_directory, stdio: 'pipe' });
        execFileSync('git', ['add', '-A'], { cwd: target_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: target_directory, stdio: 'pipe' });

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
    });

    afterEach(async () => {
        await destroy_sandbox(sandbox_id, { force: true });
        fs.rmSync(source_directory, { recursive: true, force: true });
        fs.rmSync(target_directory, { recursive: true, force: true });
    });

    // Five tests originally lived here:
    //   - `applies a modification patch`
    //   - `applies a patch that adds a new file`
    //   - `applies a patch that deletes a file`
    //   - `dry-run does not modify files`
    //   - `applies from a patch file`
    // The subject under test (`apply_patch` / `apply_patch_file`) is host-side
    // `git apply`; the sandbox was fixture overhead. They moved to
    // `test/unit/apply.test.ts` with hand-crafted unified-diff fixtures. The
    // round-trip test below stays because divergence detection requires a real
    // sandbox-authored patch that the host CANNOT predict the content-hash of
    // ahead of time — proving the failure path against a hand-crafted divergent
    // fixture would just be testing that we wrote a bad patch. See
    // [documents/testing-strategy.md](../../documents/testing-strategy.md)
    // "Before moving a test, reconcile against existing coverage" for the
    // placement rule.

    it('reports failure when file has diverged', () => {
        exec_container(container_name, ['sh', '-c', "echo 'sandbox change' > a.txt"], { cwd });
        const patch = generate_patch(sandbox_id);

        // Modify target to diverge
        fs.writeFileSync(path.join(target_directory, 'a.txt'), 'completely different\n');

        const result = apply_patch(target_directory, patch);
        expect(result.success).toBe(false);
        // Whole-or-nothing failure: no file silently applied alongside the
        // failure. A partial apply here would corrupt the target.
        expect(result.applied).toEqual([]);
        expect(result.failed.map((entry) => entry.file_path)).toContain('a.txt');
        // Target survives unchanged — the load-bearing contract of a failed
        // `git apply` without `--3way`. Verified for both the diverged file
        // AND the file the patch did not touch.
        expect(fs.readFileSync(path.join(target_directory, 'a.txt'), 'utf-8'))
            .toBe('completely different\n');
        expect(fs.readFileSync(path.join(target_directory, 'b.txt'), 'utf-8'))
            .toBe('hello\n');
    });

});
