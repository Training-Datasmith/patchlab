import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject_provider_host_files } from '../../../src/sandbox/host_access.js';

const mock_warn = vi.fn();

vi.mock('../../../src/container_runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/container_runtime.js')>();
    return {
        ...actual,
        copy_to_container: vi.fn(),
        exec_container: vi.fn(),
    };
});

vi.mock('../../../src/logger.js', () => ({
    logger: () => ({
        warn: mock_warn,
    }),
}));

import { copy_to_container, exec_container } from '../../../src/container_runtime.js';

const mocked_copy_to_container = vi.mocked(copy_to_container);
const mocked_exec_container = vi.mocked(exec_container);

describe('inject_provider_host_files', () => {
    beforeEach(() => {
        mocked_copy_to_container.mockReset();
        mocked_exec_container.mockReset();
        mock_warn.mockReset();
    });

    it('creates parent directories as root before copying', () => {
        inject_provider_host_files('container-a', [{
            host_path: '/host/opencode.json',
            container_path: '/home/patchlab/.config/opencode/opencode.json',
        }]);

        expect(mocked_exec_container).toHaveBeenCalledWith(
            'container-a',
            ['mkdir', '-p', '/home/patchlab/.config/opencode'],
            { user: 'root' },
        );
        expect(mocked_copy_to_container).toHaveBeenCalledTimes(1);
        expect(mocked_exec_container).toHaveBeenCalledWith(
            'container-a',
            ['chown', '-R', 'patchlab:patchlab', '/home/patchlab/.config'],
            { user: 'root' },
        );
    });

    it('throws when fail_on_error is true and copy fails', () => {
        mocked_copy_to_container.mockImplementation(() => {
            throw new Error('permission denied');
        });

        expect(() => inject_provider_host_files('container-a', [{
            host_path: '/host/opencode.json',
            container_path: '/home/patchlab/.config/opencode/opencode.json',
        }], { fail_on_error: true })).toThrow(
            /Failed to copy host file '\/host\/opencode.json' into sandbox: permission denied/,
        );
        expect(mock_warn).not.toHaveBeenCalled();
    });

    it('warns and continues when fail_on_error is false', () => {
        mocked_copy_to_container.mockImplementation(() => {
            throw new Error('permission denied');
        });

        inject_provider_host_files('container-a', [{
            host_path: '/host/opencode.json',
            container_path: '/home/patchlab/.config/opencode/opencode.json',
        }]);

        expect(mock_warn).toHaveBeenCalledWith(
            expect.stringContaining("failed to copy host file '/host/opencode.json'"),
        );
    });
});
