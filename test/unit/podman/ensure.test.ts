import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { ensure_podman, _reset_podman_verified } from '../../../src/podman.js';
import type { Prompter } from '../../../src/prompts.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../../helpers/recording_logger.js';

const mocked_exec = vi.mocked(execFileSync);

// Inline Prompter helper for tests that drive the machine-reset confirm
// branch (`start_or_recover_machine`). Tests that DON'T expect to reach
// the prompt pass `null` instead; the safe-default fires and surfaces
// the failure path explicitly.
function make_test_prompter(confirm_answer: boolean): Prompter {
    return {
        confirm: async () => confirm_answer,
        choose: async () => { throw new Error('choose unused in ensure_podman tests'); },
    };
}

describe('ensure_podman', () => {
    const recording_handle = install_recording_logger_hooks();
    let recording_logger: RecordingLogger;

    beforeEach(() => {
        mocked_exec.mockReset();
        _reset_podman_verified();
        vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit');
        });
        recording_logger = recording_handle.current();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exits with message when podman is not installed', async () => {
        const enoent = Object.assign(new Error('spawn podman ENOENT'), { code: 'ENOENT' });
        mocked_exec.mockImplementationOnce(() => { throw enoent; });

        await expect(ensure_podman(null)).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: 'Podman is not installed.' });
    });

    it('exits with the error object when podman --version fails for a non-ENOENT reason', async () => {
        const access_error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        mocked_exec.mockImplementationOnce(() => { throw access_error; });

        await expect(ensure_podman(null)).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: access_error });
    });

    it('succeeds when machine is already running and responsive', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* true\n'));
        // podman info (connectivity check)
        mocked_exec.mockReturnValueOnce(Buffer.from('{}'));

        await ensure_podman(null);
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('recovers zombie machine that reports running but is unresponsive', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list — says running
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* true\n'));
        // podman info — fails (zombie)
        mocked_exec.mockImplementationOnce(() => { throw new Error('connection refused'); });
        // recovery: machine start succeeds
        mocked_exec.mockReturnValueOnce(Buffer.from(''));

        await ensure_podman(null);
        expect(recording_logger.calls).toContainEqual({
            method: 'info',
            message: 'Podman machine reports running but is not responding.',
        });
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('auto-starts machine when stopped', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* false\n'));
        // machine start
        mocked_exec.mockReturnValueOnce(Buffer.from(''));

        await ensure_podman(null);
        expect(recording_logger.calls).toContainEqual({ method: 'info', message: 'Podman machine is not running. Starting...' });
        expect(mocked_exec).toHaveBeenCalledWith(
            'podman', ['machine', 'start'], { stdio: 'inherit' },
        );
    });

    it('recovers via stop + start when plain start fails', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* false\n'));
        // machine start fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed'); });
        // machine stop succeeds
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // machine start (retry) succeeds
        mocked_exec.mockReturnValueOnce(Buffer.from(''));

        await ensure_podman(null);
        expect(recording_logger.calls).toContainEqual({ method: 'info', message: 'Start failed. Attempting stop + start...' });
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('resets machine when stop + start fails and user confirms', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* false\n'));
        // machine start fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed'); });
        // machine stop
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // machine start (retry) fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed again'); });
        // user confirms reset via the supplied Prompter
        // machine rm -f
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // machine init
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // machine start
        mocked_exec.mockReturnValueOnce(Buffer.from(''));

        await ensure_podman(make_test_prompter(true));
        expect(recording_logger.calls).toContainEqual({ method: 'info', message: 'Resetting Podman machine...' });
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('exits when user declines reset', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* false\n'));
        // machine start fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed'); });
        // machine stop
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // machine start (retry) fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed again'); });

        await expect(ensure_podman(make_test_prompter(false))).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: 'Cannot start Podman machine.' });
    });

    it('exits at the reset-confirm gate when prompter is null (non-interactive)', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* false\n'));
        // machine start fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed'); });
        // machine stop
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // machine start (retry) fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed again'); });

        // No prompter → safe default fires (process.exit, same as decline).
        await expect(ensure_podman(null)).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: 'Cannot start Podman machine.' });
    });

    it('works on Linux native when machine list fails but info succeeds', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list fails (no machine subcommand on Linux)
        mocked_exec.mockImplementationOnce(() => { throw new Error('unknown'); });
        // podman info succeeds
        mocked_exec.mockReturnValueOnce(Buffer.from('{}'));

        await ensure_podman(null);
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('works on Linux native when no machines exist but info succeeds', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list returns empty
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // podman info succeeds
        mocked_exec.mockReturnValueOnce(Buffer.from('{}'));

        await ensure_podman(null);
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('exits when no machines and info fails', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list returns empty
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        // podman info fails
        mocked_exec.mockImplementationOnce(() => { throw new Error('no connection'); });

        await expect(ensure_podman(null)).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: 'No Podman machine found. Run: podman machine init' });
    });

    it('skips checks on subsequent calls', async () => {
        // --version
        mocked_exec.mockReturnValueOnce(Buffer.from('podman version 5.0.0\n'));
        // machine list
        mocked_exec.mockReturnValueOnce(Buffer.from('podman-machine-default* true\n'));

        await ensure_podman(null);
        const call_count = mocked_exec.mock.calls.length;

        await ensure_podman(null);
        expect(mocked_exec.mock.calls.length).toBe(call_count);
    });
});
