import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { ensure_nerdctl, _reset_nerdctl_verified } from '../../../src/nerdctl.js';
import type { Prompter } from '../../../src/prompts.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../../helpers/recording_logger.js';

const mocked_exec = vi.mocked(execFileSync);

function make_test_prompter(confirm_answer: boolean): Prompter {
    return {
        confirm: async () => confirm_answer,
        choose: async () => { throw new Error('choose unused in ensure_nerdctl tests'); },
    };
}

describe('ensure_nerdctl', () => {
    const recording_handle = install_recording_logger_hooks();
    let recording_logger: RecordingLogger;

    beforeEach(() => {
        mocked_exec.mockReset();
        _reset_nerdctl_verified();
        vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit');
        });
        recording_logger = recording_handle.current();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exits with message when nerdctl is not installed', async () => {
        const enoent = Object.assign(new Error('spawn nerdctl ENOENT'), { code: 'ENOENT' });
        mocked_exec.mockImplementationOnce(() => { throw enoent; });

        await expect(ensure_nerdctl(null)).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: 'nerdctl is not installed.' });
    });

    it('succeeds when the Lima VM is already running and nerdctl responds', async () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('nerdctl version 1.7.0\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('default Running\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('{}'));

        await ensure_nerdctl(null);
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('auto-starts Lima when the default instance exists but is stopped', async () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('nerdctl version 1.7.0\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('default Stopped\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from(''));

        await ensure_nerdctl(null);
        expect(recording_logger.calls).toContainEqual({ method: 'info', message: 'Lima VM is not running. Starting...' });
        expect(mocked_exec).toHaveBeenCalledWith('limactl', ['start', 'default'], { stdio: 'inherit' });
    });

    it('exits at the reset-confirm gate when prompter is null (non-interactive)', async () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('nerdctl version 1.7.0\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('default Stopped\n'));
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed'); });
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed again'); });

        await expect(ensure_nerdctl(null)).rejects.toThrow('process.exit');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(recording_logger.calls).toContainEqual({ method: 'error', message: 'Cannot start Lima VM.' });
    });

    it('resets Lima when stop + start fails and user confirms', async () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('nerdctl version 1.7.0\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('default Stopped\n'));
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed'); });
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        mocked_exec.mockImplementationOnce(() => { throw new Error('start failed again'); });
        mocked_exec.mockReturnValueOnce(Buffer.from(''));
        mocked_exec.mockReturnValueOnce(Buffer.from(''));

        await ensure_nerdctl(make_test_prompter(true));
        expect(recording_logger.calls).toContainEqual({ method: 'info', message: 'Resetting Lima VM...' });
        expect(process.exit).not.toHaveBeenCalled();
    });

    it('skips checks on subsequent calls', async () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('nerdctl version 1.7.0\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('default Running\n'));
        mocked_exec.mockReturnValueOnce(Buffer.from('{}'));

        await ensure_nerdctl(null);
        const call_count = mocked_exec.mock.calls.length;

        await ensure_nerdctl(null);
        expect(mocked_exec.mock.calls.length).toBe(call_count);
    });
});
