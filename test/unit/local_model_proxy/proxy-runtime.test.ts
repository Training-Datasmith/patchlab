import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { assert_present } from '../../helpers/assert_present.js';
import {
    close_proxy_servers,
    resolve_proxy_listen_config,
    start_proxy_listeners,
} from '../../../src/local_model_proxy/proxy.js';

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execFileSync: vi.fn(actual.execFileSync),
    };
});

vi.mock('../../../src/container_runtime/registry.js', () => ({
    get_container_runtime: vi.fn(),
}));

import { get_container_runtime } from '../../../src/container_runtime/registry.js';

const mock_get_container_runtime = vi.mocked(get_container_runtime);
const mock_exec_file_sync = vi.mocked(execFileSync);

describe('proxy runtime bind and client filtering', () => {
    const servers: net.Server[] = [];

    beforeEach(() => {
        mock_exec_file_sync.mockImplementation((command, args, options) => {
            const argv = args as string[];
            if (command === 'podman' && argv.includes('network') && argv.includes('inspect')) {
                return Buffer.from('10.88.0.1');
            }
            if (command === 'getent' && argv.includes('host.lima.internal')) {
                return Buffer.from('192.168.5.2 host.lima.internal');
            }
            return Buffer.from('');
        });
    });

    afterEach(() => {
        close_proxy_servers(servers.splice(0));
        vi.clearAllMocks();
    });

    it('podman prefers the bridge gateway address without client filtering', () => {
        mock_get_container_runtime.mockReturnValue({ kind: 'podman', binary: 'podman' });

        expect(resolve_proxy_listen_config()).toEqual({
            bind_address: '10.88.0.1',
            allowed_client_prefixes: [],
        });
    });

    it('nerdctl binds broadly and restricts clients to the Lima subnet', () => {
        mock_get_container_runtime.mockReturnValue({ kind: 'nerdctl', binary: 'nerdctl.lima' });

        expect(resolve_proxy_listen_config()).toEqual({
            bind_address: '0.0.0.0',
            allowed_client_prefixes: ['192.168.5.', '127.0.0.1'],
        });
    });

    it('rejects disallowed clients when filtering is enabled', async () => {
        const { listen_ports, servers: proxy_servers } = await start_proxy_listeners('0.0.0.0', [{ target_port: 59999 }], {
            allowed_client_prefixes: ['192.168.5.'],
        });
        servers.push(...proxy_servers);

        const listen_port = listen_ports.get(59999);
        assert_present(listen_port);

        await expect(new Promise<void>((resolve, reject) => {
            const client = net.connect({ host: '127.0.0.1', port: listen_port }, () => {
                client.once('error', () => resolve());
                client.once('end', () => resolve());
            });
            client.on('error', () => resolve());
            client.setTimeout(1000, () => {
                client.destroy();
                reject(new Error('connection stayed open'));
            });
        })).resolves.toBeUndefined();
    });

    it('allows clients from an approved prefix when filtering is enabled', async () => {
        const target = net.createServer((socket) => {
            socket.write('pong');
            socket.end();
        });
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const target_port = (target.address() as net.AddressInfo).port;

        const { listen_ports, servers: proxy_servers } = await start_proxy_listeners('127.0.0.1', [{ target_port }], {
            allowed_client_prefixes: ['127.0.0.1'],
        });
        servers.push(...proxy_servers, target);

        const listen_port = listen_ports.get(target_port);
        assert_present(listen_port);

        const response = await new Promise<string>((resolve, reject) => {
            const client = net.connect({ host: '127.0.0.1', port: listen_port }, () => {
                let data = '';
                client.on('data', (chunk) => {
                    data += chunk.toString();
                });
                client.on('end', () => resolve(data));
                client.on('error', reject);
            });
        });

        expect(response).toBe('pong');
    });
});
