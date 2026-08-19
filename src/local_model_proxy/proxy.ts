import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { get_container_runtime } from '../container_runtime/registry.js';

export interface Proxy_Forward {
    target_port: number;
    listen_port: number;
}

export interface Proxy_Metadata {
    pid: number;
    forwards: Proxy_Forward[];
    bind_address: string;
}

export interface Proxy_Listen_Config {
    bind_address: string;
    allowed_client_prefixes: readonly string[];
}

export interface Start_Proxy_Listeners_Options {
    allowed_client_prefixes?: readonly string[];
}

/**
 * Resolve bind address and optional client filtering for the host-side proxy.
 *
 * Podman binds to the bridge gateway so only container traffic reaches the
 * listener. Lima/nerdctl cannot bind the gateway IP on the Mac host, so those
 * runtimes listen on all interfaces and restrict clients to the Lima subnet.
 */
export function resolve_proxy_listen_config(): Proxy_Listen_Config {
    const { kind } = get_container_runtime();
    if (kind === 'nerdctl') {
        return {
            bind_address: '0.0.0.0',
            allowed_client_prefixes: resolve_nerdctl_client_prefixes(),
        };
    }

    return {
        bind_address: resolve_host_gateway_ipv4(),
        allowed_client_prefixes: [],
    };
}

/** @deprecated Use `resolve_proxy_listen_config()` instead. */
export function resolve_proxy_listen_address(): string {
    return resolve_proxy_listen_config().bind_address;
}

/**
 * Resolve the IPv4 address containers use to reach the host. Podman uses
 * host-gateway magic; nerdctl/Lima uses the VM gateway or host.lima.internal.
 */
export function resolve_host_gateway_ipv4(): string {
    const { kind } = get_container_runtime();
    if (kind === 'nerdctl') {
        return resolve_lima_host_ipv4();
    }

    try {
        const output = execFileSync(
            'podman',
            ['network', 'inspect', 'podman', '--format', '{{range .Subnets}}{{.Gateway}}{{end}}'],
            { stdio: 'pipe', encoding: 'utf-8' },
        ).trim();
        if (output !== '') {
            return output.split('\n')[0].trim();
        }
    } catch {
        /* fall through */
    }

    return '10.88.0.1';
}

function resolve_lima_host_ipv4(): string {
    try {
        const output = execFileSync(
            'getent',
            ['hosts', 'host.lima.internal'],
            { stdio: 'pipe', encoding: 'utf-8' },
        ).trim();
        const match = /^(\d+\.\d+\.\d+\.\d+)/.exec(output);
        if (match) {
            return match[1];
        }
    } catch {
        /* fall through */
    }

    return '192.168.5.2';
}

function resolve_nerdctl_client_prefixes(): readonly string[] {
    const gateway = resolve_lima_host_ipv4();
    const octets = gateway.split('.');
    if (octets.length !== 4) {
        return ['127.0.0.1'];
    }

    return [`${octets[0]}.${octets[1]}.${octets[2]}.`, '127.0.0.1'];
}

export function build_extra_hosts_entry(hostname: string): string {
    const { kind } = get_container_runtime();
    if (kind === 'nerdctl') {
        const ip = resolve_lima_host_ipv4();
        return `${hostname}:${ip}`;
    }

    return `${hostname}:host-gateway`;
}

export function is_client_allowed(
    remote_address: string | undefined,
    allowed_client_prefixes: readonly string[],
): boolean {
    if (allowed_client_prefixes.length === 0) {
        return true;
    }

    if (remote_address === undefined) {
        return false;
    }

    const normalized = remote_address.replace(/^::ffff:/, '');
    return allowed_client_prefixes.some((prefix) =>
        prefix.endsWith('.')
            ? normalized.startsWith(prefix)
            : normalized === prefix,
    );
}

/**
 * Start TCP listeners forwarding to 127.0.0.1:target_port.
 * Returns the listen port for each forward (may differ when ephemeral fallback).
 */
export async function start_proxy_listeners(
    bind_address: string,
    forwards: readonly { target_port: number }[],
    options?: Start_Proxy_Listeners_Options,
): Promise<{ bind_address: string; listen_ports: Map<number, number>; servers: net.Server[] }> {
    const allowed_client_prefixes = options?.allowed_client_prefixes ?? [];
    const listen_ports = new Map<number, number>();
    const servers: net.Server[] = [];

    try {
        for (const forward of forwards) {
            const listen_port = await listen_with_fallback(
                bind_address,
                forward.target_port,
                servers,
                allowed_client_prefixes,
            );
            listen_ports.set(forward.target_port, listen_port);
        }

        return { bind_address, listen_ports, servers };
    } catch (error) {
        close_proxy_servers(servers);
        if (bind_address !== '0.0.0.0' && is_addr_not_available(error)) {
            const fallback_prefixes = allowed_client_prefixes.length > 0
                ? allowed_client_prefixes
                : derive_fallback_client_prefixes(bind_address);
            return start_proxy_listeners('0.0.0.0', forwards, {
                allowed_client_prefixes: fallback_prefixes,
            });
        }

        throw error;
    }
}

function derive_fallback_client_prefixes(bind_address: string): readonly string[] {
    const octets = bind_address.split('.');
    if (octets.length !== 4) {
        return [];
    }

    return [`${octets[0]}.${octets[1]}.${octets[2]}.`];
}

function is_addr_not_available(error: unknown): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL';
}

function listen_with_fallback(
    bind_address: string,
    preferred_port: number,
    servers: net.Server[],
    allowed_client_prefixes: readonly string[],
): Promise<number> {
    return new Promise((resolve, reject) => {
        const try_listen = (port: number, allow_ephemeral: boolean) => {
            const server = net.createServer((client) => {
                if (!is_client_allowed(client.remoteAddress, allowed_client_prefixes)) {
                    client.destroy();
                    return;
                }

                const upstream = net.connect(
                    { host: '127.0.0.1', port: preferred_port },
                    () => {
                        client.pipe(upstream);
                        upstream.pipe(client);
                    },
                );
                client.on('error', () => upstream.destroy());
                upstream.on('error', () => client.destroy());
            });

            server.on('error', (error: NodeJS.ErrnoException) => {
                if (error.code === 'EADDRINUSE' && allow_ephemeral) {
                    try_listen(0, false);
                    return;
                }
                reject(error);
            });

            server.listen({ host: bind_address, port }, () => {
                const address = server.address();
                const bound_port = typeof address === 'object' && address !== null
                    ? address.port
                    : port;
                servers.push(server);
                resolve(bound_port);
            });
        };

        try_listen(preferred_port, true);
    });
}

export function close_proxy_servers(servers: readonly net.Server[]): void {
    for (const server of servers) {
        try {
            server.close();
        } catch {
            /* ignore */
        }
    }
}
