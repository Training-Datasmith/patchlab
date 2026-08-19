import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { mock_spawn, real_spawn } = vi.hoisted(() => {
    const child_process = require('node:child_process') as typeof import('node:child_process');
    return {
        mock_spawn: vi.fn(child_process.spawn),
        real_spawn: child_process.spawn,
    };
});

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        spawn: (...args: Parameters<typeof actual.spawn>) => mock_spawn(...args),
    };
});

import {
    read_host_proxy_metadata,
    start_host_proxy,
    stop_host_proxy,
    write_proxy_metadata_for_tests,
} from '../../../src/local_model_proxy/manager.js';
import { assert_present } from '../../helpers/assert_present.js';

function is_process_alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe('start_host_proxy lifecycle hardening', () => {
    let patchlab_home: string;
    let sandbox_id: string;
    const original_timeout = process.env.PATCHLAB_TEST_PROXY_METADATA_TIMEOUT_MS;

    beforeAll(() => {
        const build = spawnSync('npm', ['run', 'build'], {
            cwd: path.resolve(import.meta.dirname, '../../..'),
            stdio: 'pipe',
            encoding: 'utf8',
        });
        expect(build.status, build.stderr).toBe(0);
    });

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-proxy-life-'));
        process.env.PATCHLAB_HOME = patchlab_home;
        process.env.PATCHLAB_TEST_PROXY_METADATA_TIMEOUT_MS = '200';
        sandbox_id = 'proxy-lifecycle-sandbox';
        mock_spawn.mockImplementation((...args: Parameters<typeof real_spawn>) => real_spawn(...args));
    });

    afterEach(async () => {
        stop_host_proxy(sandbox_id);
        delete process.env.PATCHLAB_HOME;
        if (original_timeout === undefined) {
            delete process.env.PATCHLAB_TEST_PROXY_METADATA_TIMEOUT_MS;
        } else {
            process.env.PATCHLAB_TEST_PROXY_METADATA_TIMEOUT_MS = original_timeout;
        }
        fs.rmSync(patchlab_home, { recursive: true, force: true });
        mock_spawn.mockReset();
    });

    it('restarts when cached metadata forwards do not match the requested ports', async () => {
        const first = await start_host_proxy({
            sandbox_id,
            forwards: [{ target_port: 65520 }],
            proxy_local_models: true,
        });

        const first_pid = read_host_proxy_metadata(sandbox_id)?.pid;
        expect(first_pid).toBeDefined();

        const second = await start_host_proxy({
            sandbox_id,
            forwards: [{ target_port: 65521 }],
            proxy_local_models: true,
        });

        try {
            const metadata = read_host_proxy_metadata(sandbox_id);
            expect(metadata?.forwards).toEqual([{ target_port: 65521, listen_port: expect.any(Number) }]);
            expect(metadata?.pid).not.toBe(first_pid);
            assert_present(first_pid);
            expect(is_process_alive(first_pid)).toBe(false);
        } finally {
            await second.stop();
            try {
                await first.stop();
            } catch {
                /* first proxy already replaced */
            }
        }
    });

    it('does not reuse metadata when the recorded pid is alive but not the proxy daemon', async () => {
        const decoy: ChildProcess = real_spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
            stdio: 'ignore',
        });
        const decoy_pid = decoy.pid;
        assert_present(decoy_pid);

        write_proxy_metadata_for_tests(sandbox_id, {
            pid: decoy_pid,
            bind_address: '127.0.0.1',
            forwards: [{ target_port: 65522, listen_port: 65522 }],
        });

        try {
            const result = await start_host_proxy({
                sandbox_id,
                forwards: [{ target_port: 65522 }],
                proxy_local_models: true,
            });

            try {
                expect(read_host_proxy_metadata(sandbox_id)?.pid).not.toBe(decoy_pid);
                expect(is_process_alive(decoy_pid)).toBe(true);
            } finally {
                await result.stop();
            }
        } finally {
            decoy.kill();
        }
    });

    it('stop_host_proxy does not kill a live pid that is not the proxy daemon', () => {
        const decoy: ChildProcess = real_spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
            stdio: 'ignore',
        });
        const decoy_pid = decoy.pid;
        assert_present(decoy_pid);

        write_proxy_metadata_for_tests(sandbox_id, {
            pid: decoy_pid,
            bind_address: '127.0.0.1',
            forwards: [{ target_port: 65524, listen_port: 65524 }],
        });

        try {
            stop_host_proxy(sandbox_id);

            expect(read_host_proxy_metadata(sandbox_id)).toBeNull();
            expect(is_process_alive(decoy_pid)).toBe(true);
        } finally {
            decoy.kill();
        }
    });

    it('kills a detached daemon that never writes metadata', async () => {
        let orphan_pid: number | undefined;

        mock_spawn.mockImplementation((command, args, options) => {
            const argv = (args ?? []).map(String);
            if (argv.some((argument) => argument.includes('local_model_proxy/main.js'))) {
                const orphan = real_spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
                    detached: true,
                    stdio: 'ignore',
                });
                orphan.unref();
                orphan_pid = orphan.pid;
                return orphan;
            }

            return real_spawn(command, args, options);
        });

        await expect(start_host_proxy({
            sandbox_id,
            forwards: [{ target_port: 65523 }],
            proxy_local_models: true,
        })).rejects.toThrow('Timed out waiting for host proxy metadata');

        assert_present(orphan_pid);
        expect(is_process_alive(orphan_pid)).toBe(false);
    });
});
