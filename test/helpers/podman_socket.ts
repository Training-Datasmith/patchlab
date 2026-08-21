import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolve_podman_socket_path } from '../../src/detect/index.js';

const SOCKET_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

/** Shown when socket-mount integration tests cannot start the host podman API socket. */
export const HOST_PODMAN_SOCKET_SKIP_REASON =
    'Host podman API socket is not available — podman system service could not be started.';

export interface Host_Podman_Socket_Handle {
    path: string;
    stop: () => void;
}

function is_socket(socket_path: string): boolean {
    try {
        return fs.statSync(socket_path).isSocket();
    } catch {
        return false;
    }
}

async function wait_for_socket(socket_path: string, timeout_ms: number): Promise<boolean> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        if (is_socket(socket_path)) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return is_socket(socket_path);
}

function ensure_parent_directory(socket_path: string): void {
    fs.mkdirSync(path.dirname(socket_path), { recursive: true });
}

function stop_podman_service(service: ChildProcess): void {
    if (service.exitCode !== null || service.killed) {
        return;
    }

    service.kill('SIGTERM');
}

/**
 * Ensure the host podman REST API socket exists for integration tests that
 * bind-mount it into sandboxes. Returns null when the socket cannot be
 * started (for example on Linux hosts without a working podman service).
 */
export async function ensure_host_podman_socket(): Promise<Host_Podman_Socket_Handle | null> {
    const socket_path = resolve_podman_socket_path();
    if (is_socket(socket_path)) {
        return {
            path: socket_path,
            stop: () => {},
        };
    }

    ensure_parent_directory(socket_path);

    const unix_url = socket_path.startsWith('/')
        ? `unix://${socket_path}`
        : socket_path;

    const service = spawn('podman', ['system', 'service', '--time=0', unix_url], {
        stdio: 'ignore',
    });

    const ready = await wait_for_socket(socket_path, SOCKET_WAIT_MS);
    if (!ready) {
        stop_podman_service(service);
        return null;
    }

    return {
        path: socket_path,
        stop: () => stop_podman_service(service),
    };
}
