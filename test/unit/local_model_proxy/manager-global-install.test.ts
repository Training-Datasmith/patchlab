import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run_npm_script } from '../../helpers/run_npm_script.js';
import {
    read_host_proxy_metadata,
    stop_host_proxy,
} from '../../../src/local_model_proxy/manager.js';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');
const COMPILED_MANAGER_PATH = path.join(
    REPOSITORY_ROOT,
    'dist',
    'local_model_proxy',
    'manager.js',
);

describe('start_host_proxy from a globally installed layout', () => {
    let patchlab_home: string;
    let foreign_cwd: string;
    let original_cwd: string;
    const sandbox_id = 'global-install-proxy';

    beforeAll(() => {
        const build = run_npm_script('build', REPOSITORY_ROOT);
        expect(build.status, build.stderr).toBe(0);
        expect(fs.existsSync(COMPILED_MANAGER_PATH)).toBe(true);
    });

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-proxy-global-'));
        process.env.PATCHLAB_HOME = patchlab_home;
        foreign_cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-foreign-cwd-'));
        original_cwd = process.cwd();
        process.chdir(foreign_cwd);
    });

    afterEach(async () => {
        process.chdir(original_cwd);
        stop_host_proxy(sandbox_id);
        delete process.env.PATCHLAB_HOME;
        fs.rmSync(patchlab_home, { recursive: true, force: true });
        fs.rmSync(foreign_cwd, { recursive: true, force: true });
    });

    it('starts the detached daemon when cwd is unrelated to the install tree', async () => {
        const manager = await import(pathToFileURL(COMPILED_MANAGER_PATH).href) as typeof import('../../../src/local_model_proxy/manager.js');

        const result = await manager.start_host_proxy({
            sandbox_id,
            forwards: [{ target_port: 65534 }],
            proxy_local_models: true,
        });

        try {
            const metadata = read_host_proxy_metadata(sandbox_id);
            expect(metadata).not.toBeNull();
            expect(metadata?.forwards).toEqual([{ target_port: 65534, listen_port: expect.any(Number) }]);
            expect(result.listen_ports_by_target.get(65534)).toBe(metadata?.forwards[0]?.listen_port);
        } finally {
            await result.stop();
        }
    });
});
