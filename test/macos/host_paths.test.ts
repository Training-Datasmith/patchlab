// macOS-only coverage for runtime_host_tmpdir — Lima nerdctl staging must live
// under the home mount, while podman on darwin uses os.tmpdir(). Runs via the
// `macos` vitest project on macos-latest; self-gates locally on other hosts.

import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const IS_MACOS = process.platform === 'darwin';
const describe_on_macos = describe.runIf(IS_MACOS);

describe_on_macos('runtime_host_tmpdir', () => {
    const original_runtime_env = process.env.PATCHLAB_CONTAINER_RUNTIME;

    afterEach(() => {
        if (original_runtime_env === undefined) {
            delete process.env.PATCHLAB_CONTAINER_RUNTIME;
        } else {
            process.env.PATCHLAB_CONTAINER_RUNTIME = original_runtime_env;
        }
    });

    it('returns os.tmpdir() when PATCHLAB_CONTAINER_RUNTIME=podman on darwin', async () => {
        process.env.PATCHLAB_CONTAINER_RUNTIME = 'podman';
        const { runtime_host_tmpdir } = await import('../../src/container_runtime/host_paths.js');
        expect(runtime_host_tmpdir()).toBe(os.tmpdir());
    });

    it('returns ~/.patchlab/tmp when PATCHLAB_CONTAINER_RUNTIME=nerdctl on darwin', async () => {
        process.env.PATCHLAB_CONTAINER_RUNTIME = 'nerdctl';
        const { runtime_host_tmpdir, real_user_home } = await import('../../src/container_runtime/host_paths.js');
        const expected = path.join(real_user_home(), '.patchlab', 'tmp');
        expect(runtime_host_tmpdir()).toBe(expected);
    });
});
