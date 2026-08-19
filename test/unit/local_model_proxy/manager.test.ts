import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    host_proxy_metadata_path,
    read_host_proxy_metadata,
    stop_host_proxy,
    write_proxy_metadata_for_tests,
} from '../../../src/local_model_proxy/manager.js';

describe('host proxy metadata lifecycle', () => {
    let patchlab_home: string;
    let sandbox_id: string;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-proxy-meta-'));
        process.env.PATCHLAB_HOME = patchlab_home;
        sandbox_id = 'test-sandbox';
    });

    afterEach(() => {
        delete process.env.PATCHLAB_HOME;
        fs.rmSync(patchlab_home, { recursive: true, force: true });
    });

    it('reads and writes host proxy metadata under the sandbox archive', () => {
        const metadata = {
            pid: 4242,
            bind_address: '10.88.0.1',
            forwards: [{ target_port: 11434, listen_port: 11434 }],
        };

        write_proxy_metadata_for_tests(sandbox_id, metadata);

        const metadata_path = host_proxy_metadata_path(sandbox_id);
        expect(fs.existsSync(metadata_path)).toBe(true);
        expect(read_host_proxy_metadata(sandbox_id)).toEqual(metadata);
    });

    it('stop_host_proxy removes metadata for a dead pid', () => {
        write_proxy_metadata_for_tests(sandbox_id, {
            pid: 999999999,
            bind_address: '10.88.0.1',
            forwards: [],
        });

        stop_host_proxy(sandbox_id);

        expect(read_host_proxy_metadata(sandbox_id)).toBeNull();
    });
});
