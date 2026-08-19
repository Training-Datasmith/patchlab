import { execFileSync } from 'node:child_process';
import type { Prompter } from './prompts.js';
import type { Container_Runtime } from './container_runtime/types.js';
import { logger } from './logger.js';

export const PODMAN_BINARY = 'podman';

let _podman_verified = false;

/** Try to start the podman machine, with escalating recovery on failure.
 *  1. podman machine start
 *  2. stop + start (non-destructive restart)
 *  3. rm + init + start (full reset, requires user confirmation)
 *
 *  Non-interactive callers (`prompter: null`) skip the reset confirm and
 *  go straight to the failure path — matching the today-behavior of the
 *  pre-Prompter code, which terminated the process when stdin wasn't a
 *  TTY. See the safe-defaults table in `src/prompts.ts`.
 */
async function start_or_recover_machine(prompter: Prompter | null): Promise<void> {
    // Attempt 1: plain start
    logger().info('Podman machine is not running. Starting...');
    try {
        execFileSync(PODMAN_BINARY, ['machine', 'start'], { stdio: 'inherit' });
        return;
    } catch (_machine_start_failed) {
        // plain start failed — fall through to recovery
    }

    // Attempt 2: stop then start (clears stale state)
    logger().info('Start failed. Attempting stop + start...');
    try {
        execFileSync(PODMAN_BINARY, ['machine', 'stop'], { stdio: 'inherit' });
    } catch (_machine_already_stopped) {
        // stop may fail if already stopped — that's fine
    }
    try {
        execFileSync(PODMAN_BINARY, ['machine', 'start'], { stdio: 'inherit' });
        return;
    } catch (_machine_restart_failed) {
        // restart failed — fall through to full reset
    }

    // Attempt 3: full reset (destructive — ask first, or fail closed
    // when we have no way to ask).
    if (prompter === null) {
        logger().error('Cannot start Podman machine.');
        process.exit(1);
    }
    const ok = await prompter.confirm(
        'Machine is in a bad state. Reset it? This will remove and recreate the VM. Proceed? (Y/n) ',
        { default_yes: true },
    );
    if (!ok) {
        logger().error('Cannot start Podman machine.');
        process.exit(1);
    }

    logger().info('Resetting Podman machine...');
    try {
        execFileSync(PODMAN_BINARY, ['machine', 'rm', '-f'], { stdio: 'inherit' });
    } catch (_machine_already_gone) {
        // machine may already be gone
    }
    try {
        execFileSync(PODMAN_BINARY, ['machine', 'init'], { stdio: 'inherit' });
        execFileSync(PODMAN_BINARY, ['machine', 'start'], { stdio: 'inherit' });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().error(`Failed to reset Podman machine: ${message}`);
        logger().error('Try `podman machine init` and `podman machine start` manually to diagnose.');
        process.exit(1);
    }
}

function check_podman_binary(): void {
    try {
        execFileSync(PODMAN_BINARY, ['--version'], { stdio: 'pipe' });
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger().error('Podman is not installed.');
            logger().error('Install it from: https://podman.io/docs/installation');
        } else {
            logger().error(error instanceof Error ? error : new Error(String(error)));
        }

        process.exit(1);
    }
}

/** Verify podman is installed and its machine is running.
 *  On Windows/macOS where podman runs in a VM, auto-starts the machine if needed.
 *  Escalates through stop+start and full reset if the machine is in a bad state.
 *
 *  `prompter` is threaded into `start_or_recover_machine` for the
 *  destructive-reset confirmation; `null` callers (non-TTY contexts)
 *  fail closed with `process.exit(1)` instead of prompting. See the
 *  safe-defaults table in `src/prompts.ts`.
 */
export async function ensure_podman(prompter: Prompter | null): Promise<void> {
    if (_podman_verified) {
        return;
    }

    // 1. Check if podman binary is available
    check_podman_binary();

    // 2. Check if a machine is running (relevant on Windows/macOS)
    let machine_output = '';
    try {
        machine_output = execFileSync(
            PODMAN_BINARY,
            ['machine', 'list', '--format', '{{.Name}} {{.Running}}'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
    } catch {
        // machine subcommand may not exist on Linux native — check connectivity directly
        try {
            execFileSync(PODMAN_BINARY, ['info'], { stdio: 'pipe' });
            _podman_verified = true;
            return;
        } catch (_podman_service_unavailable) {
            logger().error('Cannot connect to Podman. Is the Podman service running?');
            process.exit(1);
        }
    }

    if (machine_output === '') {
        // No machines — could be Linux native
        try {
            execFileSync(PODMAN_BINARY, ['info'], { stdio: 'pipe' });
            _podman_verified = true;
            return;
        } catch (_podman_machine_missing) {
            logger().error('No Podman machine found. Run: podman machine init');
            process.exit(1);
        }
    }

    const lines = machine_output.split('\n').map((line) => line.trim()).filter(Boolean);
    const any_running = lines.some((line) => line.split(/\s+/).pop() === 'true');

    if (any_running) {
        // Machine reports as running but the SSH tunnel may be dead
        // (zombie state). Verify actual connectivity.
        try {
            execFileSync(PODMAN_BINARY, ['info'], { stdio: 'pipe' });
        } catch (_podman_machine_unresponsive) {
            logger().info('Podman machine reports running but is not responding.');
            await start_or_recover_machine(prompter);
        }
    } else {
        await start_or_recover_machine(prompter);
    }

    _podman_verified = true;
}

/** @internal Reset the podman verification flag (for testing). */
export function _reset_podman_verified(): void {
    _podman_verified = false;
}

export function exec_podman(
    args: string[],
    options?: Parameters<typeof execFileSync>[2],
): Buffer | string {
    return execFileSync(PODMAN_BINARY, args, options);
}

/** Resolve the Podman socket path for volume-mount injection.
 *  On Linux: `/run/podman/podman.sock` or `/run/user/{uid}/podman/podman.sock`
 *  On Windows/macOS (VM): query `podman info` for the remote socket path
 */
export function resolve_podman_socket_path(): string {
    try {
        const output = execFileSync(
            PODMAN_BINARY,
            ['info', '--format', '{{.Host.RemoteSocket.Path}}'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
        return output.replace(/^unix:\/\//, '');
    } catch (_podman_info_failed) {
        return '/run/podman/podman.sock';
    }
}

export function podman_image_exists(tag: string): boolean {
    try {
        exec_podman(['image', 'exists', tag], { stdio: 'pipe' });
        return true;
    } catch (_image_missing) {
        return false;
    }
}

export function podman_container_exists(name: string): boolean {
    try {
        exec_podman(['container', 'exists', name], { stdio: 'pipe' });
        return true;
    } catch (_container_missing) {
        return false;
    }
}

/** Podman runtime adapter — registered by `container_runtime/registry.ts`. */
export const podman_runtime: Container_Runtime = {
    kind: 'podman',
    display_name: 'Podman',
    get_binary: () => PODMAN_BINARY,
    is_available: () => true,
    ensure: ensure_podman,
    exec: exec_podman,
    resolve_socket_path: resolve_podman_socket_path,
    image_exists: podman_image_exists,
    container_exists: podman_container_exists,
    reset_verified: _reset_podman_verified,
};
