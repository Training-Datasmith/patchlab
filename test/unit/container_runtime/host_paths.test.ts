import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

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
