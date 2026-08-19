import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { is_proxy_daemon_process } from '../../../src/local_model_proxy/manager.js';

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFileSync: vi.fn(actual.execFileSync),
    };
});

const mock_exec_file_sync = vi.mocked(execFileSync);

describe('is_proxy_daemon_process', () => {
    const original_platform = process.platform;

    beforeEach(() => {
        mock_exec_file_sync.mockReset();
        Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: original_platform });
    });

    it('matches Windows-style command lines and metadata paths', () => {
        mock_exec_file_sync.mockReturnValue(
            'node.exe C:\\patchlab\\dist\\local_model_proxy\\main.js --metadata-path C:\\Users\\me\\.patchlab\\archives\\abc\\host-proxy.json',
        );

        expect(is_proxy_daemon_process(
            4242,
            'C:\\Users\\me\\.patchlab\\archives\\abc\\host-proxy.json',
        )).toBe(true);
    });

    it('rejects command lines that omit the metadata path', () => {
        mock_exec_file_sync.mockReturnValue(
            'node.exe C:\\patchlab\\dist\\local_model_proxy\\main.js --metadata-path C:\\other\\host-proxy.json',
        );

        expect(is_proxy_daemon_process(
            4242,
            'C:\\Users\\me\\.patchlab\\archives\\abc\\host-proxy.json',
        )).toBe(false);
    });
});
