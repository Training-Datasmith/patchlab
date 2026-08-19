import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { get_container_runtime } from '../../../src/container_runtime.js';
import { resolve_proxy_listen_config, start_proxy_listeners, close_proxy_servers } from '../../../src/local_model_proxy/proxy.js';

const describe_on_podman = get_container_runtime().kind === 'podman' ? describe : describe.skip;

describe_on_podman('podman proxy bind address', () => {
    it('can bind to the podman bridge gateway on Linux hosts', async () => {
        const gateway = execFileSync(
            'podman',
            ['network', 'inspect', 'podman', '--format', '{{range .Subnets}}{{.Gateway}}{{end}}'],
            { encoding: 'utf8' },
        ).trim().split('\n')[0]?.trim();
        expect(gateway).not.toBe('');

        const config = resolve_proxy_listen_config();
        expect(config.bind_address).toBe(gateway);
        expect(config.allowed_client_prefixes).toEqual([]);

        const target = net.createServer();
        await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
        const target_port = (target.address() as net.AddressInfo).port;

        const { servers } = await start_proxy_listeners(config.bind_address, [{ target_port }], {
            allowed_client_prefixes: config.allowed_client_prefixes,
        });

        try {
            expect(servers.length).toBeGreaterThan(0);
        } finally {
            close_proxy_servers(servers);
            target.close();
        }
    });
});
