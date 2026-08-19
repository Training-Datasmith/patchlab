import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import { assert_present } from '../../helpers/assert_present.js';
import {
    start_proxy_listeners,
    close_proxy_servers,
    build_extra_hosts_entry,
} from '../../../src/local_model_proxy/proxy.js';

describe('local model proxy', () => {
    const servers: net.Server[] = [];

    afterEach(() => {
        close_proxy_servers(servers.splice(0));
    });

    it('forwards TCP traffic from listen port to 127.0.0.1 target', async () => {
        const target = net.createServer((socket) => {
            socket.write('pong');
            socket.end();
        });

        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const target_port = (target.address() as net.AddressInfo).port;

        const { listen_ports, servers: proxy_servers } = await start_proxy_listeners('127.0.0.1', [
            { target_port },
        ]);
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
            client.setTimeout(2000, () => {
                client.destroy();
                reject(new Error('timeout'));
            });
        });

        expect(response).toBe('pong');
    });

    it('build_extra_hosts_entry uses host-gateway for podman runtime', () => {
        expect(build_extra_hosts_entry('host.patchlab.internal')).toBe(
            'host.patchlab.internal:host-gateway',
        );
    });
});
