import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { Prompter } from './prompts.js';
import { is_lima_mounted_host_path, nerdctl_active_on_darwin, real_user_home, runtime_host_tmpdir } from './container_runtime/host_paths.js';
import type { Container_Runtime } from './container_runtime/types.js';
import { logger } from './logger.js';

export const NERDCTL_CANDIDATES = ['nerdctl.lima', 'nerdctl'] as const;
export const LIMA_INSTANCE = 'default';

let _nerdctl_verified = false;
let _resolved_binary: string | null = null;

function find_executable_on_path(name: string): string | null {
    const path_directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const directory of path_directories) {
        const candidate = path.join(directory, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return name;
        } catch (_not_executable) {
            /* try next PATH entry */
        }
    }

    return null;
}

/** Find a nerdctl binary on the host (prefers Lima's wrapper on macOS). */
export function resolve_nerdctl_binary(): string | null {
    if (_resolved_binary) {
        return _resolved_binary;
    }

    for (const candidate of NERDCTL_CANDIDATES) {
        const found = find_executable_on_path(candidate);
        if (found) {
            _resolved_binary = found;
            return found;
        }
    }

    return null;
}

export function get_nerdctl_binary(): string {
    return resolve_nerdctl_binary() ?? 'nerdctl';
}

function check_nerdctl_binary(): void {
    const binary = get_nerdctl_binary();
    try {
        execFileSync(binary, ['--version'], { stdio: 'pipe' });
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger().error('nerdctl is not installed.');
            logger().error('On macOS, install Lima: brew install lima && limactl start');
            logger().error('See: https://lima-vm.io/docs/examples/containers/containerd/');
        } else {
            logger().error(error instanceof Error ? error : new Error(String(error)));
        }
        process.exit(1);
    }
}

async function start_or_recover_lima(prompter: Prompter | null): Promise<void> {
    logger().info('Lima VM is not running. Starting...');
    try {
        execFileSync('limactl', ['start', LIMA_INSTANCE], { stdio: 'inherit' });
        return;
    } catch (_lima_start_failed) {
        /* fall through */
    }

    logger().info('Start failed. Attempting stop + start...');
    try {
        execFileSync('limactl', ['stop', LIMA_INSTANCE], { stdio: 'inherit' });
    } catch (_lima_already_stopped) {
        /* stop may fail if already stopped */
    }
    try {
        execFileSync('limactl', ['start', LIMA_INSTANCE], { stdio: 'inherit' });
        return;
    } catch (_lima_restart_failed) {
        /* fall through */
    }

    if (prompter === null) {
        logger().error('Cannot start Lima VM.');
        process.exit(1);
    }
    const ok = await prompter.confirm(
        'Lima VM is in a bad state. Reset it? This will remove and recreate the VM. Proceed? (Y/n) ',
        { default_yes: true },
    );
    if (!ok) {
        logger().error('Cannot start Lima VM.');
        process.exit(1);
    }

    logger().info('Resetting Lima VM...');
    try {
        execFileSync('limactl', ['delete', LIMA_INSTANCE, '--force'], { stdio: 'inherit' });
        execFileSync('limactl', ['start', LIMA_INSTANCE, '--tty=false'], { stdio: 'inherit' });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().error(`Failed to reset Lima VM: ${message}`);
        logger().error('Try `limactl start` manually to diagnose.');
        process.exit(1);
    }
}

/** Verify nerdctl is installed and the Lima VM is running. */
export async function ensure_nerdctl(prompter: Prompter | null): Promise<void> {
    if (_nerdctl_verified) {
        return;
    }

    check_nerdctl_binary();

    let lima_output = '';
    try {
        lima_output = execFileSync(
            'limactl',
            ['list', '--format', '{{.Name}} {{.Status}}'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
    } catch {
        logger().error('limactl is not installed. Install Lima: brew install lima');
        process.exit(1);
    }

    const instance_line = lima_output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith(`${LIMA_INSTANCE} `));

    const running = instance_line?.includes('Running') ?? false;

    if (running) {
        try {
            exec_nerdctl(['info'], { stdio: 'pipe' });
        } catch (_nerdctl_unresponsive) {
            logger().info('Lima VM reports running but nerdctl is not responding.');
            await start_or_recover_lima(prompter);
        }
    } else if (instance_line) {
        await start_or_recover_lima(prompter);
    } else {
        logger().info('No Lima instance found. Creating default instance...');
        try {
            execFileSync('limactl', ['start', LIMA_INSTANCE, '--tty=false'], { stdio: 'inherit' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().error(`Failed to start Lima: ${message}`);
            process.exit(1);
        }
    }

    _nerdctl_verified = true;
}

/** @internal Reset nerdctl verification state (for testing). */
export function _reset_nerdctl_verified(): void {
    _nerdctl_verified = false;
    _resolved_binary = null;
}

export function query_nerdctl_runtime_capacity(): { memory_bytes: number; cpu_count: number } | null {
    if (!nerdctl_active_on_darwin()) {
        return null;
    }

    try {
        const mem_kb = execFileSync(
            'limactl',
            ['shell', LIMA_INSTANCE, '--', 'awk', '/MemTotal/ {print $2}', '/proc/meminfo'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
        const cpu_count_text = execFileSync(
            'limactl',
            ['shell', LIMA_INSTANCE, '--', 'nproc'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
        const memory_bytes = Number(mem_kb) * 1024;
        const cpu_count = Number(cpu_count_text);
        if (!Number.isFinite(memory_bytes) || memory_bytes <= 0 || !Number.isFinite(cpu_count) || cpu_count <= 0) {
            return null;
        }
        return { memory_bytes, cpu_count };
    } catch (_lima_query_failed) {
        return null;
    }
}

export function exec_nerdctl(
    args: string[],
    options?: Parameters<typeof execFileSync>[2],
): Buffer | string {
    return execFileSync(get_nerdctl_binary(), args, options);
}

function container_home_user(container_path: string): string | null {
    const home_match = container_path.match(/^\/home\/([^/]+)(?:\/|$)/);
    if (home_match) {
        return home_match[1];
    }

    if (container_path === '/root' || container_path.startsWith('/root/')) {
        return 'root';
    }

    return null;
}

/** nerdctl cp preserves the macOS host UID; restore image-user ownership for git/tool access. */
function nerdctl_fix_copied_ownership(name: string, container_path: string): void {
    const user = container_home_user(container_path);
    if (!user) {
        return;
    }

    const target = container_path.endsWith('/.') ? container_path.slice(0, -2) : container_path;
    exec_nerdctl(
        [
            'exec', '-u', 'root', name,
            'chown', '-R', `${user}:${user}`, target,
        ],
        { stdio: 'pipe' },
    );
}

/** Reconcile ownership on the full workspace tree before git or tool commands run. */
export function nerdctl_fix_workspace_ownership(name: string, working_directory: string): void {
    nerdctl_fix_copied_ownership(name, working_directory);
}

function nerdctl_needs_root_install(container_path: string): boolean {
    if (container_path.startsWith('/tmp/')) {
        return false;
    }

    return container_path === '/root'
        || container_path.startsWith('/root/')
        || container_path.startsWith('/home/');
}

/**
 * Copy host bytes into a container path under /home or /root via /tmp — direct
 * nerdctl cp cannot mkdir those destinations on Lima.
 */
export function nerdctl_install_into_container_path(
    name: string,
    host_path: string,
    container_destination: string,
): void {
    const temp_root = `/tmp/patchlab-cp-${crypto.randomUUID()}`;
    const copies_directory_contents = host_path.endsWith('/.');
    nerdctl_copy_to_container_direct(
        name,
        host_path,
        copies_directory_contents ? `${temp_root}/.` : temp_root,
    );
    exec_nerdctl(
        [
            'exec', '-u', 'root', name,
            'sh', '-c',
            'set -e; mkdir -p "$(dirname "$2")"; '
            + 'if [ -d "$1" ]; then mkdir -p "$2"; cp -a "$1"/. "$2"/; else cp -a "$1" "$2"; fi; rm -rf "$1"',
            'patchlab-cp', temp_root, container_destination,
        ],
        { stdio: 'pipe' },
    );
    nerdctl_fix_copied_ownership(name, container_destination);
}

/** Copy host bytes into a workspace path via /tmp — nerdctl cp rejects some workspace targets directly. */
export function nerdctl_install_into_workspace(
    name: string,
    host_path: string,
    container_destination: string,
    working_directory: string,
): void {
    const temp_root = `/tmp/patchlab-ws-copy-${crypto.randomUUID()}`;
    const staging_directory = host_path.endsWith('/.');
    nerdctl_copy_to_container_direct(name, host_path, staging_directory ? `${temp_root}/.` : temp_root);
    exec_nerdctl(
        [
            'exec', '-u', 'root', '-w', working_directory, name,
            'sh', '-c',
            'set -e; mkdir -p "$(dirname "$2")"; rm -rf "$2"; '
            + 'if [ -d "$1" ]; then cp -a "$1"/. "$2"/; else cp -a "$1" "$2"; fi; rm -rf "$1"',
            'patchlab-ws-copy', temp_root, container_destination,
        ],
        { stdio: 'pipe' },
    );
    nerdctl_fix_workspace_ownership(name, working_directory);
}

/**
 * nerdctl cp reads host sources from inside the Lima VM. Only paths under the
 * mounted home directory are visible; macOS temp dirs under /var/folders fail.
 * When the source is outside the mount, stage a copy under ~/.patchlab/tmp first
 * while preserving the `cp` trailing-/. semantics expected by callers.
 */
export function nerdctl_copy_to_container(
    name: string,
    host_path: string,
    container_path: string,
): void {
    if (nerdctl_needs_root_install(container_path)) {
        nerdctl_install_into_container_path(name, host_path, container_path);
        return;
    }

    nerdctl_copy_to_container_direct(name, host_path, container_path);
}

function nerdctl_copy_to_container_direct(
    name: string,
    host_path: string,
    container_path: string,
): void {
    if (is_lima_mounted_host_path(host_path)) {
        exec_nerdctl(['cp', host_path, `${name}:${container_path}`], { stdio: 'pipe' });
        nerdctl_fix_copied_ownership(name, container_path);
        return;
    }

    const staging_root = fs.mkdtempSync(path.join(runtime_host_tmpdir(), 'patchlab-cp-stage-'));
    try {
        const staged_source = stage_host_path_for_nerdctl(host_path, staging_root);
        exec_nerdctl(['cp', staged_source, `${name}:${container_path}`], { stdio: 'pipe' });
        nerdctl_fix_copied_ownership(name, container_path);
    } finally {
        fs.rmSync(staging_root, { recursive: true, force: true });
    }
}

/** Mirror host_path under staging_root so nerdctl cp sees Lima-visible bytes. */
function stage_host_path_for_nerdctl(host_path: string, staging_root: string): string {
    if (host_path.endsWith('/.')) {
        const source_directory = path.resolve(host_path.slice(0, -2));
        const destination = path.join(staging_root, 'contents');
        fs.cpSync(source_directory, destination, { recursive: true, force: true });
        return `${destination}/.`;
    }

    const resolved = path.resolve(host_path);
    if (fs.statSync(resolved).isDirectory()) {
        const destination = path.join(staging_root, path.basename(resolved));
        fs.cpSync(resolved, destination, { recursive: true, force: true });
        return destination;
    }

    const destination = path.join(staging_root, path.basename(resolved));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(resolved, destination);
    return destination;
}

/**
 * Lima virtiofs mounts the user home read-only for nerdctl cp host destinations,
 * so bytes leave the container via exec streams and land on the host with Node.
 */
export function nerdctl_copy_from_container(
    name: string,
    container_path: string,
    host_path: string,
): void {
    let copies_directory_contents = false;
    try {
        exec_nerdctl(['exec', name, 'test', '-d', container_path], { stdio: 'pipe' });
        copies_directory_contents = true;
    } catch (_not_a_directory) {
        /* copy the path as-is */
    }

    fs.mkdirSync(path.dirname(host_path), { recursive: true });
    if (fs.existsSync(host_path)) {
        fs.rmSync(host_path, { recursive: true, force: true });
    }

    if (copies_directory_contents) {
        fs.mkdirSync(host_path, { recursive: true });
        const tar_process = spawnSync(
            get_nerdctl_binary(),
            ['exec', '-u', 'root', name, 'tar', '-C', container_path, '-cf', '-', '.'],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        if (tar_process.status !== 0) {
            const stderr = tar_process.stderr?.toString('utf-8').trim();
            throw new Error(stderr || `nerdctl exec tar failed with status ${tar_process.status}`);
        }

        const extract_process = spawnSync('tar', ['-xf', '-', '-C', host_path], {
            input: tar_process.stdout,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (extract_process.status !== 0) {
            const stderr = extract_process.stderr?.toString('utf-8').trim();
            throw new Error(stderr || `host tar extract failed with status ${extract_process.status}`);
        }
        return;
    }

    const content = exec_nerdctl(['exec', '-u', 'root', name, 'cat', container_path], {
        stdio: 'pipe',
    });
    fs.writeFileSync(host_path, content);
}

/** Resolve the containerd socket path inside the Lima VM. */
export function resolve_nerdctl_socket_path(): string {
    try {
        const output = execFileSync(
            'limactl',
            ['shell', LIMA_INSTANCE, '--', 'sh', '-c', 'echo /run/user/$(id -u)/containerd/containerd.sock'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
        if (output) {
            return output;
        }
    } catch (_lima_shell_failed) {
        /* fall through */
    }

    return '/run/user/501/containerd/containerd.sock';
}

export function nerdctl_image_exists(tag: string): boolean {
    try {
        exec_nerdctl(['image', 'inspect', tag], { stdio: 'pipe' });
        return true;
    } catch (_image_missing) {
        return false;
    }
}

export function nerdctl_container_exists(name: string): boolean {
    try {
        exec_nerdctl(['container', 'inspect', name], { stdio: 'pipe' });
        return true;
    } catch (_container_missing) {
        return false;
    }
}

export const nerdctl_runtime: Container_Runtime = {
    kind: 'nerdctl',
    display_name: 'nerdctl',
    get_binary: get_nerdctl_binary,
    is_available: () => process.platform === 'darwin' && resolve_nerdctl_binary() !== null,
    ensure: ensure_nerdctl,
    exec: exec_nerdctl,
    resolve_socket_path: resolve_nerdctl_socket_path,
    image_exists: nerdctl_image_exists,
    container_exists: nerdctl_container_exists,
    reset_verified: _reset_nerdctl_verified,
};
