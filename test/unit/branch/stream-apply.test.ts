/**
 * Unit coverage for `stream_apply_from_sandbox`'s exit-code handling.
 *
 * The happy path (a real `cat | git apply` pipe) is exercised end-to-end by the
 * integration suite. These tests cover the FAILURE paths that integration can't
 * provoke deterministically, and that previously caused silent data loss:
 *
 *   - `cat` (the `podman exec` reading the diff) exits non-zero: `git apply`
 *     sees empty input and exits 0, so without inspecting cat's code the promise
 *     would resolve and the session would "commit" nothing. Must REJECT.
 *   - a child is killed by a signal (e.g. the OOM killer reaps `git apply`):
 *     its close code is null. Mapping null→0 would launder that into success,
 *     so a signalled close must REJECT.
 *   - both children exit 0: the only resolve path.
 *
 * `spawn` is mocked to hand back fake EventEmitter children whose `close` events
 * the test drives by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('node:child_process', () => ({
    spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { stream_apply_from_sandbox } from '../../../src/branch/session_commit.js';

const mocked_spawn = vi.mocked(spawn);

interface Fake_Child extends EventEmitter {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
}

function make_fake_child(): Fake_Child {
    const child = new EventEmitter() as Fake_Child;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    return child;
}

describe('stream_apply_from_sandbox — exit-code handling', () => {
    let cat: Fake_Child;
    let apply: Fake_Child;

    beforeEach(() => {
        mocked_spawn.mockReset();
        // The function spawns `cat` first, then `git apply`.
        cat = make_fake_child();
        apply = make_fake_child();
        mocked_spawn
            .mockReturnValueOnce(cat as unknown as ReturnType<typeof spawn>)
            .mockReturnValueOnce(apply as unknown as ReturnType<typeof spawn>);
    });

    function invoke(): Promise<void> {
        return stream_apply_from_sandbox('container-x', '/tmp/slice.diff', '/host/repo', '/tmp/index');
    }

    it('resolves only after BOTH children close, when both exit 0', async () => {
        const promise = invoke();
        cat.emit('close', 0, null);
        apply.emit('close', 0, null);
        await expect(promise).resolves.toBeUndefined();
    });

    it('rejects when cat exits non-zero even though git apply exits 0 (silent-empty-input guard)', async () => {
        const promise = invoke();
        cat.stderr.emit('data', Buffer.from('cat: /tmp/slice.diff: No such file or directory'));
        // git apply saw empty input and "succeeded".
        apply.emit('close', 0, null);
        cat.emit('close', 1, null);
        await expect(promise).rejects.toThrow(/reading container diff failed \(cat exit 1\)/);
        await expect(promise).rejects.toThrow(/No such file/);
    });

    it('rejects with git apply context when apply exits non-zero', async () => {
        const promise = invoke();
        apply.stderr.emit('data', Buffer.from('error: patch does not apply'));
        apply.emit('close', 1, null);
        cat.emit('close', 0, null);
        await expect(promise).rejects.toThrow(/git apply failed \(exit 1\)/);
        await expect(promise).rejects.toThrow(/patch does not apply/);
    });

    it('rejects when git apply is killed by a signal (null code must not read as success)', async () => {
        const promise = invoke();
        // OOM killer: code null, signal set. Cat closed cleanly.
        apply.emit('close', null, 'SIGKILL');
        cat.emit('close', 0, null);
        await expect(promise).rejects.toThrow(/git apply failed \(signal SIGKILL\)/);
    });

    it('rejects when cat is killed by a signal', async () => {
        const promise = invoke();
        apply.emit('close', 0, null);
        cat.emit('close', null, 'SIGTERM');
        await expect(promise).rejects.toThrow(/reading container diff failed \(cat signal SIGTERM\)/);
    });

    it('tears down both children on failure', async () => {
        const promise = invoke();
        apply.emit('close', 2, null);
        cat.emit('close', 0, null);
        await expect(promise).rejects.toThrow();
        expect(cat.kill).toHaveBeenCalled();
        expect(apply.kill).toHaveBeenCalled();
    });
});
