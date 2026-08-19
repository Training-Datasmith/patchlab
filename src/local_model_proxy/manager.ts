import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { build_archive_path } from '../archive.js';
import { parse_file_as_json } from '../json_validators.js';
import { logger } from '../logger.js';
import { HOST_PATCHLAB_INTERNAL } from '../tools/host_access.js';
import {
    build_extra_hosts_entry,
    type Proxy_Forward,
    type Proxy_Metadata,
    resolve_proxy_listen_config,
} from './proxy.js';

export const HOST_PROXY_METADATA_FILENAME = 'host-proxy.json';

function proxy_metadata_timeout_ms(): number {
    const parsed = Number(process.env.PATCHLAB_TEST_PROXY_METADATA_TIMEOUT_MS ?? 5000);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

export function host_proxy_metadata_path(sandbox_id: string): string {
    return path.join(build_archive_path(sandbox_id), HOST_PROXY_METADATA_FILENAME);
}

export function read_host_proxy_metadata(sandbox_id: string): Proxy_Metadata | null {
    const metadata_path = host_proxy_metadata_path(sandbox_id);
    if (!fs.existsSync(metadata_path)) {
        return null;
    }

    try {
        return parse_file_as_json(metadata_path) as Proxy_Metadata;
    } catch {
        return null;
    }
}

function write_host_proxy_metadata(sandbox_id: string, metadata: Proxy_Metadata): void {
    const metadata_path = host_proxy_metadata_path(sandbox_id);
    fs.mkdirSync(path.dirname(metadata_path), { recursive: true });
    fs.writeFileSync(metadata_path, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
}

function is_process_alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function kill_process_if_alive(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!is_process_alive(pid)) {
        return;
    }

    try {
        process.kill(pid, signal);
    } catch {
        /* already gone */
    }
}

function terminate_proxy_process(
    pid: number,
    metadata_path: string,
    child?: ChildProcess,
): void {
    if (child !== undefined && !child.killed) {
        try {
            child.kill('SIGKILL');
        } catch {
            /* ignore */
        }
    }

    if (!is_proxy_daemon_process(pid, metadata_path)) {
        return;
    }

    kill_process_if_alive(pid, 'SIGKILL');

    if (process.platform !== 'win32') {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            /* ignore */
        }
    }
}

async function wait_for_process_exit(pid: number, timeout_ms: number): Promise<void> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        if (!is_process_alive(pid)) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function read_process_cmdline(pid: number): string {
    if (process.platform === 'win32') {
        return execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        ).trim();
    }

    const proc_path = `/proc/${pid}/cmdline`;
    if (fs.existsSync(proc_path)) {
        return fs.readFileSync(proc_path, 'utf8').replaceAll('\0', ' ');
    }

    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function cmdline_matches_proxy_daemon(cmdline: string, metadata_path: string): boolean {
    const normalized_cmdline = cmdline.replaceAll('\\', '/');
    const normalized_metadata = metadata_path.replaceAll('\\', '/');
    return normalized_cmdline.includes('local_model_proxy/main.js')
        && normalized_cmdline.includes(normalized_metadata);
}

/** @internal Verify a pid belongs to the detached proxy daemon. */
export function is_proxy_daemon_process(pid: number, metadata_path: string): boolean {
    try {
        const cmdline = read_process_cmdline(pid);
        return cmdline_matches_proxy_daemon(cmdline, metadata_path);
    } catch {
        return false;
    }
}

function forwards_match_requested(
    requested: readonly { target_port: number }[],
    existing: readonly Proxy_Forward[],
): boolean {
    const requested_ports = requested.map((forward) => forward.target_port).sort((left, right) => left - right);
    const existing_ports = existing.map((forward) => forward.target_port).sort((left, right) => left - right);
    return requested_ports.length === existing_ports.length
        && requested_ports.every((port, index) => port === existing_ports[index]);
}

export function stop_host_proxy(sandbox_id: string): void {
    const metadata_path = host_proxy_metadata_path(sandbox_id);
    const metadata = read_host_proxy_metadata(sandbox_id);
    if (metadata === null) {
        return;
    }

    if (
        is_process_alive(metadata.pid)
        && is_proxy_daemon_process(metadata.pid, metadata_path)
    ) {
        kill_process_if_alive(metadata.pid);
    }

    try {
        fs.unlinkSync(metadata_path);
    } catch {
        /* ignore */
    }
}

export interface Start_Host_Proxy_Options {
    sandbox_id: string;
    forwards: readonly { target_port: number }[];
    proxy_local_models: boolean;
}

export interface Start_Host_Proxy_Result {
    extra_hosts: string[];
    listen_ports_by_target: Map<number, number>;
    stop: () => Promise<void>;
}

/**
 * Start or reuse a detached host-side TCP proxy for local model endpoints.
 * When `proxy_local_models` is false, returns hostname mapping only.
 */
export async function start_host_proxy(
    options: Start_Host_Proxy_Options,
): Promise<Start_Host_Proxy_Result> {
    const extra_hosts = [build_extra_hosts_entry(HOST_PATCHLAB_INTERNAL)];
    const listen_ports_by_target = new Map<number, number>();

    if (options.forwards.length === 0) {
        return {
            extra_hosts,
            listen_ports_by_target,
            stop: async () => stop_host_proxy(options.sandbox_id),
        };
    }

    for (const forward of options.forwards) {
        listen_ports_by_target.set(forward.target_port, forward.target_port);
    }

    if (!options.proxy_local_models) {
        return {
            extra_hosts,
            listen_ports_by_target,
            stop: async () => stop_host_proxy(options.sandbox_id),
        };
    }

    const metadata_path = host_proxy_metadata_path(options.sandbox_id);
    const existing = read_host_proxy_metadata(options.sandbox_id);
    if (
        existing !== null
        && is_process_alive(existing.pid)
        && is_proxy_daemon_process(existing.pid, metadata_path)
        && forwards_match_requested(options.forwards, existing.forwards)
    ) {
        for (const forward of existing.forwards) {
            listen_ports_by_target.set(forward.target_port, forward.listen_port);
        }
        logger().verbose(
            `Reusing host proxy pid ${existing.pid} for sandbox ${options.sandbox_id}`,
        );
        return {
            extra_hosts,
            listen_ports_by_target,
            stop: async () => stop_host_proxy(options.sandbox_id),
        };
    }

    stop_host_proxy(options.sandbox_id);

    const listen_config = resolve_proxy_listen_config();
    const daemon_path = resolve_proxy_main_script();

    fs.mkdirSync(path.dirname(metadata_path), { recursive: true });

    const child: ChildProcess = spawn(
        process.execPath,
        [
            daemon_path,
            '--metadata-path',
            metadata_path,
            '--bind-address',
            listen_config.bind_address,
            '--allowed-client-prefixes',
            JSON.stringify(listen_config.allowed_client_prefixes),
            '--forwards',
            JSON.stringify(options.forwards),
        ],
        {
            detached: true,
            stdio: 'ignore',
            env: process.env,
        },
    );

    child.unref();

    const pid = child.pid;
    if (pid === undefined) {
        throw new Error('Failed to start host proxy daemon');
    }

    try {
        await wait_for_proxy_metadata(metadata_path, pid, proxy_metadata_timeout_ms());
    } catch (error) {
        terminate_proxy_process(pid, metadata_path, child);
        await wait_for_process_exit(pid, 500);
        throw error;
    }

    const metadata = read_host_proxy_metadata(options.sandbox_id);
    if (metadata === null) {
        terminate_proxy_process(pid, metadata_path, child);
        await wait_for_process_exit(pid, 500);
        throw new Error('Host proxy daemon did not write metadata');
    }

    listen_ports_by_target.clear();
    for (const forward of metadata.forwards) {
        listen_ports_by_target.set(forward.target_port, forward.listen_port);
    }

    logger().verbose(
        `Started host proxy pid ${metadata.pid} for sandbox ${options.sandbox_id} `
        + `(${metadata.forwards.length} forward(s) on ${metadata.bind_address})`,
    );

    return {
        extra_hosts,
        listen_ports_by_target,
        stop: async () => stop_host_proxy(options.sandbox_id),
    };
}

async function wait_for_proxy_metadata(
    metadata_path: string,
    expected_pid: number,
    timeout_ms: number,
): Promise<void> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
        if (fs.existsSync(metadata_path)) {
            try {
                const metadata = parse_file_as_json(metadata_path) as Proxy_Metadata;
                if (metadata.pid === expected_pid) {
                    return;
                }
            } catch {
                /* retry */
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error('Timed out waiting for host proxy metadata');
}

export function write_proxy_metadata_for_tests(
    sandbox_id: string,
    metadata: Proxy_Metadata,
): void {
    write_host_proxy_metadata(sandbox_id, metadata);
}

function resolve_proxy_main_script(): string {
    const directory = path.dirname(__filename);
    const sibling = path.join(directory, 'main.js');
    if (fs.existsSync(sibling)) {
        return sibling;
    }

    const built = path.resolve(directory, '../../dist/local_model_proxy/main.js');
    if (fs.existsSync(built)) {
        return built;
    }

    throw new Error('Proxy daemon entrypoint missing; run npm run build');
}
