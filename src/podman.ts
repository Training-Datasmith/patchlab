import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Prompter } from './prompts.js';
import { assert_safe_patchlab_id } from './archive.js';
import { logger } from './logger.js';
import { safe_unlink } from './safe_filesystem.js';

// The container runtime is podman-only by design for now; making it pluggable
// (Docker / nerdctl / Lima) in the future.

const EXEC_MAX_BUFFER = 50 * 1024 * 1024;

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
        execFileSync('podman', ['machine', 'start'], { stdio: 'inherit' });
        return;
    } catch (_machine_start_failed) {
        // plain start failed — fall through to recovery
    }

    // Attempt 2: stop then start (clears stale state)
    logger().info('Start failed. Attempting stop + start...');
    try {
        execFileSync('podman', ['machine', 'stop'], { stdio: 'inherit' });
    } catch (_machine_already_stopped) {
        // stop may fail if already stopped — that's fine
    }
    try {
        execFileSync('podman', ['machine', 'start'], { stdio: 'inherit' });
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
        execFileSync('podman', ['machine', 'rm', '-f'], { stdio: 'inherit' });
    } catch (_machine_already_gone) {
        // machine may already be gone
    }
    try {
        execFileSync('podman', ['machine', 'init'], { stdio: 'inherit' });
        execFileSync('podman', ['machine', 'start'], { stdio: 'inherit' });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().error(`Failed to reset Podman machine: ${message}`);
        logger().error('Try `podman machine init` and `podman machine start` manually to diagnose.');
        process.exit(1);
    }
}

function check_podman_binary(): void {
    try {
        execFileSync('podman', ['--version'], { stdio: 'pipe' });
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
            'podman',
            ['machine', 'list', '--format', '{{.Name}} {{.Running}}'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
    } catch {
        // machine subcommand may not exist on Linux native — check connectivity directly
        try {
            execFileSync('podman', ['info'], { stdio: 'pipe' });
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
            execFileSync('podman', ['info'], { stdio: 'pipe' });
            _podman_verified = true;
            return;
        } catch (_podman_machine_missing) {
            logger().error('No Podman machine found. Run: podman machine init');
            process.exit(1);
        }
    }

    const lines = machine_output.split('\n').map(l => l.trim()).filter(Boolean);
    const any_running = lines.some(line => line.split(/\s+/).pop() === 'true');

    if (any_running) {
        // Machine reports as running but the SSH tunnel may be dead
        // (zombie state). Verify actual connectivity.
        try {
            execFileSync('podman', ['info'], { stdio: 'pipe' });
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

export const DEFAULT_IMAGE = 'node:22-slim';
export const CONTAINER_UID = 1000;
export const CONTAINER_USER = 'patchlab';
export const CONTAINER_HOME = `/home/${CONTAINER_USER}`;
export const CONTAINER_WORKING_DIR = `${CONTAINER_HOME}/workspace`;
export const CONTAINER_NAME_PREFIX = 'patchlab-';

/**
 * Derive the conventional home directory for `image_user`: `/home/${image_user}`.
 *
 * This helper is DERIVED-ONLY — it does NOT honor any per-provider `image_home`
 * override declared in a configured-provider manifest. Callers that need
 * override-aware home resolution MUST read from
 * `provider.image_specification.image_home` instead.
 *
 * The helper is retained as the canonical derivation point for the
 * `/home/${image_user}` form so future callers needing this convention have one
 * home for it rather than open-coding the template.
 */
export function get_image_home(image_user: string): string {
    return `/home/${image_user}`;
}

/**
 * Derive the conventional workspace directory: `${get_image_home(image_user)}/workspace`.
 *
 * Like `get_image_home`, this helper is DERIVED-ONLY: it returns the standard
 * `/home/${image_user}/workspace` shape and does NOT consult any per-provider
 * `image_home` override. Provider-aware call sites that need override propagation
 * MUST call `compute_container_workspace_path(provider)` from `tools/index.ts`.
 *
 * The function name keeps its non-prefixed form (`get_working_directory`, not
 * `get_image_working_directory`) because the workspace directory it returns is
 * a patchlab-runtime concept, not image-baked vocabulary.
 */
export function get_working_directory(image_user: string): string {
    return `${get_image_home(image_user)}/workspace`;
}

export interface Container_Create_Options {
    image?: string;
    volume_mounts?: string[];
    environment_variables?: Record<string, string>;
    extra_environment_variables?: Record<string, string>;
    /**
     * Resource-limit flags forwarded to `podman create`. Each field is the
     * argv value the resolver decided on (in podman's native format).
     * `undefined` omits the corresponding flag — that is the only way to
     * express "unlimited" to podman cleanly, and it's also how
     * `blkio_weight` "not set anywhere" is conveyed.
     */
    memory_limit?: string;
    cpu_limit?: string;
    pids_limit?: number;
    blkio_weight?: number;
}

export function container_name_for(sandbox_id: string): string {
    assert_safe_patchlab_id(sandbox_id);
    return `${CONTAINER_NAME_PREFIX}${sandbox_id}`;
}

export function create_container(
    name: string,
    image: string,
    options?: Container_Create_Options
): void {
    const args = ['create', '--name', name];
    push_socket_userns_flag(args, options?.volume_mounts);
    push_volume_mount_flags(args, options?.volume_mounts);

    // Combine all env vars and pass via --env-file. The file is mode 0o600 in
    // os.tmpdir() so values aren't visible on the `podman create` command line
    // (where another process could read them via /proc/<pid>/cmdline or `ps`).
    // GEMINI_API_KEY is the canonical example, but the same protection covers
    // user-supplied environment_variables that may carry connection strings or
    // other secret-shaped values.
    const env_file_path = write_env_file(
        options?.environment_variables,
        options?.extra_environment_variables
    );
    try {
        if (env_file_path) {
            args.push('--env-file', env_file_path);
        }

        push_resource_limit_flags(args, options);

        args.push(image, 'sleep', 'infinity');
        execFileSync('podman', args, { stdio: 'pipe' });
    } finally {
        if (env_file_path) {
            safe_unlink(env_file_path);
        }
    }
}

/** Preserve UID mapping so the container user can access a host socket mount. */
function push_socket_userns_flag(args: string[], volume_mounts: string[] | undefined): void {
    const socket_mounted = volume_mounts?.some(
        (m) => m.includes('podman.sock') || m.includes('docker.sock')
    );
    if (socket_mounted) {
        args.push('--userns=keep-id');
    }
}

function push_volume_mount_flags(args: string[], volume_mounts: string[] | undefined): void {
    if (!volume_mounts) {
        return;
    }

    for (const mount of volume_mounts) {
        args.push('-v', mount);
    }
}

/**
 * Resource-limit flags. Placed before the image positional argument (per
 * Decision 6). Each flag is omitted entirely when its option is `undefined`
 * — that's how "unlimited" (memory/cpus/pids) and "not set anywhere"
 * (blkio_weight) reach podman.
 */
function push_resource_limit_flags(args: string[], options: Container_Create_Options | undefined): void {
    if (options?.memory_limit !== undefined) {
        args.push('--memory', options.memory_limit);
    }
    if (options?.cpu_limit !== undefined) {
        args.push('--cpus', options.cpu_limit);
    }
    if (options?.pids_limit !== undefined) {
        args.push('--pids-limit', String(options.pids_limit));
    }
    if (options?.blkio_weight !== undefined) {
        args.push('--blkio-weight', String(options.blkio_weight));
    }
}

function write_env_file(
    base: Record<string, string> | undefined,
    extra: Record<string, string> | undefined
): string | null {
    const merged: Record<string, string> = {};
    if (base) {
        for (const [key, value] of Object.entries(base)) {
            merged[key] = value;
        }
    }
    if (extra) {
        for (const [key, value] of Object.entries(extra)) {
            if (key in merged) {
                throw new Error(`Duplicate environment variable key: ${key}`);
            }
            merged[key] = value;
        }
    }

    const entries = Object.entries(merged);
    if (entries.length === 0) {
        return null;
    }

    // --env-file format: one KEY=VALUE per line, no quoting/escaping. Reject values
    // that contain newlines so we don't silently drop trailing content.
    const lines: string[] = [];
    for (const [key, value] of entries) {
        if (value.includes('\n') || value.includes('\r')) {
            throw new Error(
                `Environment variable ${key} contains a newline; cannot pass via --env-file.`
            );
        }
        lines.push(`${key}=${value}`);
    }

    // Hold secrets in a temporary directory file with an unguessable name, opened
    // with O_EXCL (the `x` flag) so a pre-existing file or attacker-planted symlink
    // at the path fails the open rather than being silently followed — secrets must
    // never be written through a symlink on a shared /tmp. The random suffix removes
    // the guessable pid+timestamp name; O_EXCL closes the residual create race.
    const file_path = path.join(
        os.tmpdir(),
        `patchlab-env-${process.pid}-${crypto.randomBytes(9).toString('hex')}.env`
    );
    const file_descriptor = fs.openSync(file_path, 'wx', 0o600);
    try {
        fs.writeFileSync(file_descriptor, lines.join('\n') + '\n', { encoding: 'utf-8' });
    } finally {
        fs.closeSync(file_descriptor);
    }

    return file_path;
}

export function start_container(name: string): void {
    execFileSync('podman', ['start', name], { stdio: 'pipe' });
}

export function stop_container(name: string): void {
    execFileSync('podman', ['stop', '-t', '5', name], { stdio: 'pipe' });
}

export function remove_container(name: string): void {
    execFileSync('podman', ['rm', '-f', name], { stdio: 'pipe' });
}

/**
 * Best-effort teardown: `podman stop` then `podman rm -f`, swallowing errors
 * at each step. Most failures mean "nothing to do" — the container is already
 * stopped/removed, or never reached create. After both calls, we probe
 * `container_exists(name)`: if the container is still present, both attempts
 * truly failed (podman socket unreachable, permission denied, etc.) and the
 * caller's cleanup is incomplete — surface a warning so the leak is visible
 * instead of silent. When podman itself is unavailable, `container_exists`
 * returns false on its own catch path, so the warning stays quiet there too.
 *
 * Test-mockability note: `stop_container`, `remove_container`, and
 * `container_exists` are referenced as same-module bindings here, so a
 * `vi.mock('../src/podman.js', ...)` that replaces those EXPORTS does NOT
 * intercept the calls inside this helper. Unit tests that need to assert on
 * the individual sub-calls SHOULD call `stop_container` / `remove_container`
 * directly rather than routing through this wrapper.
 */
export function stop_and_remove_container_best_effort(name: string): void {
    try {
        stop_container(name);
    } catch (_container_not_running) {
        /* already stopped or never created */
    }

    try {
        remove_container(name);
    } catch (_container_already_gone) {
        /* already removed or never created */
    }

    if (container_exists(name)) {
        logger().warn(
            `Container ${name} is still present after stop + rm -f. `
            + 'Check that podman is reachable and that no other process is holding the container.',
        );
    }
}

export function exec_container(
    name: string,
    command: string[],
    options?: { cwd?: string }
): string {
    const args = ['exec'];
    if (options?.cwd) {
        args.push('-w', options.cwd);
    }
    args.push(name, ...command);
    const result = execFileSync('podman', args, { stdio: 'pipe', maxBuffer: EXEC_MAX_BUFFER });
    return result.toString('utf-8');
}

/**
 * Like `exec_container`, but returns the child's stdout as a raw `Buffer` with
 * no UTF-8 decode. Use for capturing `git diff --binary` from inside the
 * container, whose output carries the raw bytes of latin1/non-UTF-8 files —
 * `toString('utf-8')` would replace those bytes with U+FFFD and corrupt the
 * patch before it is applied host-side.
 */
export function exec_container_capture_buffer(
    name: string,
    command: string[],
    options?: { cwd?: string }
): Buffer {
    const args = ['exec'];
    if (options?.cwd) {
        args.push('-w', options.cwd);
    }

    args.push(name, ...command);
    return execFileSync('podman', args, { stdio: 'pipe', maxBuffer: EXEC_MAX_BUFFER });
}

export function exec_interactive(
    name: string,
    command: string[],
    working_directory?: string,
): void {
    const cwd = working_directory ?? CONTAINER_WORKING_DIR;
    const args = ['exec', '-it', '-w', cwd, name, ...command];
    execFileSync('podman', args, { stdio: 'inherit' });
}

/**
 * Copy `host_path` to `container_path` inside `name` via `podman cp`. The
 * `host_path` argument is forwarded BYTE-FOR-BYTE to `podman cp` — callers
 * control the trailing-slash semantics (which determine whether a directory
 * is copied AS the destination or whether its CONTENTS are copied INTO an
 * existing destination):
 *
 *   - `host_path = "/tmp/data"`        → copies the `data` directory itself
 *     to `container_path`. Container side ends up with `<container_path>`
 *     being or containing the new `data/` directory.
 *   - `host_path = "/tmp/data/."`      → copies the CONTENTS of `data/` into
 *     an already-existing `container_path`. Directory itself is not nested.
 *   - `host_path = "/tmp/file.txt"`    → copies the single file to
 *     `container_path` (file-to-file or file-to-existing-directory).
 *
 * The wrapper deliberately does NOT normalize or reinterpret these forms;
 * patchlab's internal callers depend on the unchanged-passthrough contract.
 */
export function copy_to_container(
    name: string,
    host_path: string,
    container_path: string
): void {
    execFileSync('podman', ['cp', host_path, `${name}:${container_path}`], {
        stdio: 'pipe',
    });
}

export function copy_from_container(
    name: string,
    container_path: string,
    host_path: string
): void {
    execFileSync('podman', ['cp', `${name}:${container_path}`, host_path], {
        stdio: 'pipe',
    });
}

export function image_exists(tag: string): boolean {
    try {
        execFileSync('podman', ['image', 'exists', tag], { stdio: 'pipe' });
        return true;
    } catch (_image_missing) {
        return false;
    }
}

export function container_exists(name: string): boolean {
    try {
        execFileSync('podman', ['container', 'exists', name], { stdio: 'pipe' });
        return true;
    } catch (_container_missing) {
        return false;
    }
}

export function container_running(name: string): boolean {
    try {
        const result = execFileSync(
            'podman',
            ['container', 'inspect', '--format', '{{.State.Running}}', name],
            { stdio: 'pipe' }
        );
        return result.toString('utf-8').trim() === 'true';
    } catch (_container_inspect_failed) {
        return false;
    }
}

/**
 * A running container as surfaced to the service-resolution flow and to the
 * interactive selection prompt: just enough fields for a human to recognise
 * the candidate (name + image + ports). Populated by `query_running_containers`.
 */
export interface Running_Container {
    name: string;
    image: string;
    ports: string;
}

interface Podman_Container_Info {
    Names?: string[];
    Image?: string;
    Ports?: {
        host_port?: number;
        container_port?: number;
        hostPort?: number;
        containerPort?: number;
    }[];
}

/**
 * Enumerate the containers currently running on the host via `podman ps`,
 * normalising the raw `podman ps --format json` shape into the
 * `Running_Container` projection. Returns `[]` on any podman failure (the
 * caller treats "no candidates" the same whether podman is unreachable or
 * simply has nothing running).
 */
export function query_running_containers(): Running_Container[] {
    try {
        const output = execFileSync(
            'podman',
            ['ps', '--format', 'json'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();

        if (!output || output === '[]') {
            return [];
        }

        const containers = JSON.parse(output) as Podman_Container_Info[];
        return containers.map((c) => {
            const name = c.Names?.[0] ?? '<unnamed>';
            const image = c.Image ?? '<unknown>';
            const ports = (c.Ports ?? [])
                .map((p) => {
                    const host = p.host_port ?? p.hostPort ?? 0;
                    const container = p.container_port ?? p.containerPort ?? 0;
                    return host ? `${host}:${container}` : String(container);
                })
                .join(', ') || 'none';
            return { name, image, ports };
        });
    } catch (_podman_ps_failed) {
        return [];
    }
}

/**
 * Whether the image carries the `biz.ecartz.patchlab.compatible=true` label.
 * Compatibility is independent of which AI tool is installed — see `get_image_tool_state`
 * for per-tool state.
 */
export function is_patchlab_compatible_image(image: string): boolean {
    try {
        const result = execFileSync(
            'podman',
            ['image', 'inspect', '--format', '{{index .Labels "biz.ecartz.patchlab.compatible"}}', image],
            { stdio: 'pipe' }
        );
        return result.toString('utf-8').trim() === 'true';
    } catch (_image_inspect_failed) {
        return false;
    }
}

/**
 * Per-tool state recorded by the `biz.ecartz.patchlab.tool.<tool>` image label.
 * Four mutually-exclusive values:
 *
 *  - `'absent'` — the image carries no per-tool label for this tool.
 *  - `'installed'` — tool binary baked in, NO authentication injected at
 *    build time. Either the provider's `get_authentication_method()` returns
 *    `'none'`, or `inject_authentication` returned `{ type: 'none' }`
 *    (e.g., an `'environment_variables'` provider whose declared variables
 *    were all unset at build time).
 *  - `'authenticated'` — tool binary baked in AND **credentials ARE baked
 *    into the image filesystem**. Only `'file_copy'`-method providers produce
 *    this state. A container created from this image needs neither tool
 *    installation nor auth re-injection — the credentials would survive a
 *    `podman save | podman load` round trip.
 *  - `'ready'` — tool binary baked in AND `inject_authentication` returned a
 *    non-`'none'` result at build time, but the credentials are NOT in the
 *    image filesystem. Only `'environment_variables'`-method providers
 *    produce this state. The env var must still be passed at create-time;
 *    image bytes carry nothing reusable across hosts.
 *
 * The `'authenticated'` vs `'ready'` distinction is load-bearing: future
 * features that ship pre-authenticated image bundles consult it to decide
 * whether an image is safe to share publicly. A predicate
 * `was_authentication_attempted_at_build` collapses the two for sites that
 * only care whether auth ran at build time; the strict `=== 'authenticated'`
 * literal is reserved for sites that mean "credentials in image bytes."
 */
export type Tool_State = 'absent' | 'installed' | 'authenticated' | 'ready';

/** Check the per-tool state label for a specific tool. Pure label read — no container spawning. */
export function get_image_tool_state(image: string, tool: string): Tool_State {
    try {
        const label_key = `biz.ecartz.patchlab.tool.${tool}`;
        const result = execFileSync(
            'podman',
            ['image', 'inspect', '--format', `{{index .Labels "${label_key}"}}`, image],
            { stdio: 'pipe' }
        );
        const value = result.toString('utf-8').trim();
        // If-chain ordered so a future state addition is a one-line insertion.
        if (value === 'authenticated') {
            return 'authenticated';
        }
        if (value === 'ready') {
            return 'ready';
        }
        if (value === 'installed') {
            return 'installed';
        }
        return 'absent';
    } catch (_tool_label_inspect_failed) {
        return 'absent';
    }
}

/**
 * True when the image's per-tool state records that authentication was
 * attempted (and succeeded) at build time. Covers both:
 *  - `'authenticated'` — credentials baked into image bytes (file_copy).
 *  - `'ready'` — auth result captured at build, credentials supplied at
 *    runtime via env var (environment_variables).
 *
 * Use this predicate at call sites that ask "did auth run when this image
 * was built?" Do NOT use it for "are credentials in the image's bytes?" —
 * that is the strict `tool_state === 'authenticated'` check. The spec
 * distinguishes these two semantics and so do we.
 */
export function was_authentication_attempted_at_build(state: Tool_State): boolean {
    return state === 'authenticated' || state === 'ready';
}

/** Commit a running container as a new image with additional labels. */
export function commit_container(
    container_name: string,
    image_tag: string,
    labels?: Record<string, string>,
): void {
    const args = ['commit'];
    if (labels) {
        for (const [key, value] of Object.entries(labels)) {
            // JSON.stringify yields the double-quoted, `"`/`\`-escaped token the
            // `--change "LABEL key=value"` parser expects, so a value containing a
            // quote, backslash, or newline cannot break out of the LABEL and
            // inject a further committed-image directive. Same treatment the ENV
            // block in images.ts uses; keys here are internal constants.
            args.push('-c', `LABEL ${key}=${JSON.stringify(value)}`);
        }
    }
    args.push(container_name, image_tag);
    execFileSync('podman', args, { stdio: 'pipe' });
}

const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;

export function install_package(name: string, package_name: string): void {
    if (!PACKAGE_NAME_PATTERN.test(package_name)) {
        throw new Error(`Invalid package name: '${package_name}' does not match Debian package naming convention`);
    }
    exec_container(name, [
        'sh', '-c',
        `dpkg -s ${package_name} > /dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends ${package_name})`,
    ]);
}
