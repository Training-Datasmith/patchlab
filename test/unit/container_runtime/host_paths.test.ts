import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runtime_host_tmpdir', () => {
    const original_platform = process.platform;
    const original_runtime_env = process.env.PATCHLAB_CONTAINER_RUNTIME;

    beforeEach(() => {
        vi.stubGlobal('process', {
            ...process,
            platform: 'darwin',
        });
    });

    afterEach(() => {
        vi.stubGlobal('process', { ...process, platform: original_platform });
        if (original_runtime_env === undefined) {
            delete process.env.PATCHLAB_CONTAINER_RUNTIME;
        } else {
            process.env.PATCHLAB_CONTAINER_RUNTIME = original_runtime_env;
        }
        vi.resetModules();
    });

    it('returns os.tmpdir() when PATCHLAB_CONTAINER_RUNTIME=podman on darwin', async () => {
        process.env.PATCHLAB_CONTAINER_RUNTIME = 'podman';
        const { runtime_host_tmpdir } = await import('../../../src/container_runtime/host_paths.js');
        expect(runtime_host_tmpdir()).toBe(os.tmpdir());
    });

    it('returns ~/.patchlab/tmp when PATCHLAB_CONTAINER_RUNTIME=nerdctl on darwin', async () => {
        process.env.PATCHLAB_CONTAINER_RUNTIME = 'nerdctl';
        const { runtime_host_tmpdir, real_user_home } = await import('../../../src/container_runtime/host_paths.js');
        const expected = path.join(real_user_home(), '.patchlab', 'tmp');
        expect(runtime_host_tmpdir()).toBe(expected);
    });
});

describe('is_lima_mounted_host_path', () => {
    it('accepts paths under the home directory', async () => {
        const { is_lima_mounted_host_path, real_user_home } = await import('../../../src/container_runtime/host_paths.js');
        expect(is_lima_mounted_host_path(path.join(real_user_home(), '.patchlab', 'tmp', 'staging'))).toBe(true);
    });

    it('rejects macOS temp dirs outside the home mount', async () => {
        const { is_lima_mounted_host_path } = await import('../../../src/container_runtime/host_paths.js');
        expect(is_lima_mounted_host_path('/var/folders/abc/T/patchlab-staging')).toBe(false);
    });
});
