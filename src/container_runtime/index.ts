import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assert_safe_patchlab_id } from '../archive.js';
import { logger } from '../logger.js';
import { nerdctl_copy_from_container, nerdctl_copy_to_container, nerdctl_fix_workspace_ownership, nerdctl_install_into_workspace } from '../nerdctl.js';
import { safe_unlink } from '../safe_filesystem.js';
import { runtime_host_tmpdir } from './host_paths.js';
import {
    container_exists,
    exec_runtime,
    get_container_runtime,
    get_runtime_display_name,
} from './registry.js';

export {
    assert_required_container_runtime,
} from './required_runtime.js';
export {
    ensure_container_runtime,
    exec_runtime,
    get_active_runtime,
    get_container_runtime,
    get_registered_runtime,
    get_runtime_binary,
    get_runtime_display_name,
    image_exists,
    container_exists,
    list_container_runtimes,
    register_container_runtime,
    resolve_runtime_socket_path,
    _reset_container_runtime,
} from './registry.js';
export type { Container_Runtime, Container_Runtime_Kind, Runtime_Exec_Options } from './types.js';
export { runtime_host_tmpdir, is_lima_mounted_host_path } from './host_paths.js';

export function fix_workspace_ownership_if_needed(name: string, working_directory: string): void {
    if (get_container_runtime().kind === 'nerdctl') {
        nerdctl_fix_workspace_ownership(name, working_directory);
    }
}

export function copy_into_workspace(
    name: string,
    host_path: string,
    working_directory: string,
    destination_relative: string,
): void {
    const container_destination = path.posix.join(
        working_directory,
        ...destination_relative.split(path.sep),
    );
    if (get_container_runtime().kind === 'nerdctl') {
        nerdctl_install_into_workspace(name, host_path, container_destination, working_directory);
        return;
    }

    exec_container(name, ['mkdir', '-p', path.posix.dirname(container_destination)]);
    copy_to_container(name, host_path, container_destination);
}

const EXEC_MAX_BUFFER = 50 * 1024 * 1024;

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

/** Align container HOME/USER with the provider image so tools read the right config tree. */
export function provider_image_environment(
    image_home: string,
    image_user: string,
): Record<string, string> {
    return {
        HOME: image_home,
        USER: image_user,
    };
}

export interface Container_Create_Options {
    image?: string;
    volume_mounts?: string[];
    environment_variables?: Record<string, string>;
    extra_environment_variables?: Record<string, string>;
    /** Entries for `podman create --add-host` (hostname:ip or hostname:host-gateway). */
    extra_hosts?: string[];
    /**
     * Resource-limit flags forwarded to container `create`. Each field is the
     * argv value the resolver decided on (in the runtime's native format).
     * `undefined` omits the corresponding flag — that is the only way to
     * express "unlimited" cleanly, and it's also how
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
    options?: Container_Create_Options,
): void {
    const args = ['create', '--name', name];
    push_socket_userns_flag(args, options?.volume_mounts);
    push_volume_mount_flags(args, options?.volume_mounts);
    push_extra_host_flags(args, options?.extra_hosts);

    // Combine all env vars and pass via --env-file. The file is mode 0o600 in
    // runtime_host_tmpdir() so values aren't visible on the `create` command line
    // (where another process could read them via /proc/<pid>/cmdline or `ps`).
    // GEMINI_API_KEY is the canonical example, but the same protection covers
    // user-supplied environment_variables that may carry connection strings or
    // other secret-shaped values.
    const env_file_path = write_env_file(
        options?.environment_variables,
        options?.extra_environment_variables,
    );
    try {
        if (env_file_path) {
            args.push('--env-file', env_file_path);
        }

        push_resource_limit_flags(args, options);

        args.push(image, 'sleep', 'infinity');
        exec_runtime(args, { stdio: 'pipe' });
    } finally {
        if (env_file_path) {
            safe_unlink(env_file_path);
        }
    }
}

/** Preserve UID mapping so the container user can access a host socket mount. */
function push_socket_userns_flag(args: string[], volume_mounts: string[] | undefined): void {
    const socket_mounted = volume_mounts?.some(
        (m) => m.includes('podman.sock') || m.includes('docker.sock') || m.includes('containerd.sock'),
    );
    if (socket_mounted) {
        const { kind } = get_container_runtime();
        if (kind === 'nerdctl') {
            // nerdctl rejects `--userns=keep-id`; host namespace allows socket access.
            args.push('--userns', 'host');
        } else {
            args.push('--userns=keep-id');
        }
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

function push_extra_host_flags(args: string[], extra_hosts: string[] | undefined): void {
    if (!extra_hosts) {
        return;
    }

    for (const entry of extra_hosts) {
        args.push('--add-host', entry);
    }
}

/**
 * Resource-limit flags. Placed before the image positional argument (per
 * Decision 6). Each flag is omitted entirely when its option is `undefined`
 * — that's how "unlimited" (memory/cpus/pids) and "not set anywhere"
 * (blkio_weight) reach the runtime.
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
    extra: Record<string, string> | undefined,
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
                `Environment variable ${key} contains a newline; cannot pass via --env-file.`,
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
        runtime_host_tmpdir(),
        `patchlab-env-${process.pid}-${crypto.randomBytes(9).toString('hex')}.env`,
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
    exec_runtime(['start', name], { stdio: 'pipe' });
}

export function stop_container(name: string): void {
    exec_runtime(['stop', '-t', '5', name], { stdio: 'pipe' });
}

export function remove_container(name: string): void {
    exec_runtime(['rm', '-f', name], { stdio: 'pipe' });
}

export function rename_container(from_name: string, to_name: string): void {
    exec_runtime(['rename', from_name, to_name], { stdio: 'pipe' });
}

/** Ephemeral container name used while resume provisioning runs. */
export function resume_staging_container_name(patchlab_id: string): string {
    assert_safe_patchlab_id(patchlab_id);
    const suffix = crypto.randomBytes(4).toString('hex');
    return `${container_name_for(patchlab_id)}-resume-${suffix}`;
}

/** Backup name for the previous container during a resume swap. */
export function resume_previous_container_backup_name(patchlab_id: string): string {
    assert_safe_patchlab_id(patchlab_id);
    const suffix = crypto.randomBytes(4).toString('hex');
    return `${container_name_for(patchlab_id)}-previous-${suffix}`;
}

/**
 * Swap a successfully provisioned staging container into the canonical sandbox
 * name. When the previous container already occupies the final name, it is
 * renamed to a backup first so a failed staging rename can be rolled back.
 * The caller removes the backup after manifest/session metadata commit.
 */
export function finalize_resumed_container(
    staging_name: string,
    previous_container_name: string,
    final_name: string,
    patchlab_id: string,
): string | null {
    let backup_name: string | null = null;

    if (
        previous_container_name !== staging_name
        && container_exists(previous_container_name)
    ) {
        backup_name = resume_previous_container_backup_name(patchlab_id);
        rename_container(previous_container_name, backup_name);
    }

    try {
        if (staging_name !== final_name) {
            rename_container(staging_name, final_name);
        }
    } catch (error) {
        if (backup_name !== null && container_exists(backup_name)) {
            try {
                rename_container(backup_name, previous_container_name);
            } catch (restore_error) {
                const restore_message = restore_error instanceof Error
                    ? restore_error.message
                    : String(restore_error);
                logger().warn(
                    `Warning: failed to restore previous container after resume finalize rollback — ${restore_message}`,
                );
            }
        }
        throw error;
    }

    return backup_name;
}

/**
 * Best-effort teardown: `stop` then `rm -f`, swallowing errors
 * at each step. Most failures mean "nothing to do" — the container is already
 * stopped/removed, or never reached create. After both calls, we probe
 * `container_exists(name)`: if the container is still present, both attempts
 * truly failed (runtime socket unreachable, permission denied, etc.) and the
 * caller's cleanup is incomplete — surface a warning so the leak is visible
 * instead of silent. When the runtime itself is unavailable, `container_exists`
 * returns false on its own catch path, so the warning stays quiet there too.
 *
 * Test-mockability note: `stop_container`, `remove_container`, and
 * `container_exists` are referenced as same-module bindings here, so a
 * `vi.mock('../src/container_runtime.js', ...)` that replaces those EXPORTS does NOT
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
            + `Check that ${get_runtime_display_name()} is reachable and that no other process is holding the container.`,
        );
    }
}

function infer_exec_user(
    command: string[],
    options?: { cwd?: string; user?: string },
): string | undefined {
    if (options?.user) {
        return options.user;
    }
    if (options?.cwd) {
        return container_home_user(options.cwd) ?? undefined;
    }
    if (command[0] === 'git' && command[1] === '-C' && command[2]) {
        return container_home_user(command[2]) ?? undefined;
    }
    return undefined;
}

function push_exec_user_and_cwd_args(
    args: string[],
    command: string[],
    options?: { cwd?: string; user?: string },
): void {
    const user = infer_exec_user(command, options);
    if (user) {
        args.push('-u', user);
    }
    if (options?.cwd) {
        args.push('-w', options.cwd);
    }
}

export function exec_container(
    name: string,
    command: string[],
    options?: { cwd?: string; user?: string },
): string {
    const args = ['exec'];
    push_exec_user_and_cwd_args(args, command, options);
    args.push(name, ...command);
    const result = exec_runtime(args, { stdio: 'pipe', maxBuffer: EXEC_MAX_BUFFER });
    return result.toString('utf-8');
}

/** Derive the image user name from a `/home/<user>/…` or `/root/…` container path. */
export function container_home_user(container_path: string): string | null {
    const home_match = container_path.match(/^\/home\/([^/]+)(?:\/|$)/);
    if (home_match) {
        return home_match[1];
    }

    if (container_path === '/root' || container_path.startsWith('/root/')) {
        return 'root';
    }

    return null;
}

/** Go-template path to labels in `image inspect` output — podman uses `.Labels`, nerdctl uses `.Config.Labels`. */
function image_inspect_labels_go_path(): string {
    const { kind } = get_container_runtime();
    return kind === 'nerdctl' ? '.Config.Labels' : '.Labels';
}

/** Read one label from a local image. Returns an empty string when absent or on inspect failure. */
export function read_image_label(image: string, label_key: string): string {
    try {
        const labels_path = image_inspect_labels_go_path();
        const result = exec_runtime(
            ['image', 'inspect', '--format', `{{index ${labels_path} "${label_key}"}}`, image],
            { stdio: 'pipe' },
        );
        return result.toString('utf-8').trim();
    } catch (_image_label_inspect_failed) {
        return '';
    }
}

/** Read the full label map from a local image. Returns `{}` on inspect failure. */
export function read_image_labels(image: string): Record<string, string> {
    try {
        const labels_path = image_inspect_labels_go_path();
        const result = exec_runtime(
            ['image', 'inspect', '--format', `{{json ${labels_path}}}`, image],
            { stdio: 'pipe' },
        );
        const parsed = JSON.parse(result.toString('utf-8').trim()) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch (_image_labels_inspect_failed) {
        return {};
    }
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
    options?: { cwd?: string; user?: string },
): Buffer {
    const args = ['exec'];
    push_exec_user_and_cwd_args(args, command, options);
    args.push(name, ...command);
    return exec_runtime(args, { stdio: 'pipe', maxBuffer: EXEC_MAX_BUFFER }) as Buffer;
}

export function exec_interactive(
    name: string,
    command: string[],
    working_directory?: string,
): void {
    const cwd = working_directory ?? CONTAINER_WORKING_DIR;
    const args = ['exec'];
    if (process.stdin.isTTY && process.stdout.isTTY) {
        args.push('-it');
    }
    const user = container_home_user(cwd);
    if (user) {
        args.push('-u', user);
    }
    args.push('-w', cwd, name, ...command);
    exec_runtime(args, { stdio: 'inherit' });
}

/**
 * Copy `host_path` to `container_path` inside `name` via `cp`. The
 * `host_path` argument is forwarded BYTE-FOR-BYTE to the runtime — callers
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
    container_path: string,
): void {
    const { kind } = get_container_runtime();
    if (kind === 'nerdctl') {
        nerdctl_copy_to_container(name, host_path, container_path);
        return;
    }

    exec_runtime(['cp', host_path, `${name}:${container_path}`], { stdio: 'pipe' });
}

export function copy_from_container(
    name: string,
    container_path: string,
    host_path: string,
): void {
    const { kind } = get_container_runtime();
    if (kind === 'nerdctl') {
        nerdctl_copy_from_container(name, container_path, host_path);
        return;
    }

    exec_runtime(['cp', `${name}:${container_path}`, host_path], { stdio: 'pipe' });
}

export function container_running(name: string): boolean {
    try {
        const result = exec_runtime(
            ['container', 'inspect', '--format', '{{.State.Running}}', name],
            { stdio: 'pipe' },
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

interface Container_Info {
    Names?: string[] | string;
    Image?: string;
    Ports?: string | {
        host_port?: number;
        container_port?: number;
        hostPort?: number;
        containerPort?: number;
    }[];
}

function parse_ps_json_output(output: string): Container_Info[] {
    const trimmed = output.trim();
    if (!trimmed || trimmed === '[]') {
        return [];
    }

    if (trimmed.startsWith('[')) {
        return JSON.parse(trimmed) as Container_Info[];
    }

    return trimmed
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Container_Info);
}

function container_display_name(names: Container_Info['Names']): string {
    if (Array.isArray(names)) {
        return names[0] ?? '<unnamed>';
    }
    if (typeof names === 'string' && names !== '') {
        return names;
    }
    return '<unnamed>';
}

function format_container_ports(ports: Container_Info['Ports']): string {
    if (typeof ports === 'string') {
        return ports === '' ? 'none' : ports;
    }

    const formatted = (ports ?? [])
        .map((p) => {
            const host = p.host_port ?? p.hostPort ?? 0;
            const container = p.container_port ?? p.containerPort ?? 0;
            return host ? `${host}:${container}` : String(container);
        })
        .join(', ');
    return formatted || 'none';
}

/**
 * Enumerate the containers currently running on the host via `ps --format json`,
 * normalising the raw output shape into the `Running_Container` projection.
 * Returns `[]` on any runtime failure (the caller treats "no candidates" the
 * same whether the runtime is unreachable or simply has nothing running).
 */
export function query_running_containers(): Running_Container[] {
    try {
        const output = exec_runtime(['ps', '--format', 'json'], { stdio: 'pipe' })
            .toString('utf-8');

        const containers = parse_ps_json_output(output);
        return containers.map((c) => ({
            name: container_display_name(c.Names),
            image: c.Image ?? '<unknown>',
            ports: format_container_ports(c.Ports),
        }));
    } catch (_ps_failed) {
        return [];
    }
}

/**
 * Whether the image carries the `biz.ecartz.patchlab.compatible=true` label.
 * Compatibility is independent of which AI tool is installed — see `get_image_tool_state`
 * for per-tool state.
 */
export function is_patchlab_compatible_image(image: string): boolean {
    return read_image_label(image, 'biz.ecartz.patchlab.compatible') === 'true';
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
 *    installation nor auth re-injection — the credentials would survive an
 *    image save/load round trip.
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
    const label_key = `biz.ecartz.patchlab.tool.${tool}`;
    const value = read_image_label(image, label_key);
    switch (value) {
        case 'authenticated':
            return 'authenticated';
        case 'ready':
            return 'ready';
        case 'installed':
            return 'installed';
        default:
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
    if (!labels || Object.keys(labels).length === 0) {
        exec_runtime(['commit', container_name, image_tag], { stdio: 'pipe' });
        return;
    }

    const { kind } = get_container_runtime();
    if (kind === 'nerdctl') {
        nerdctl_commit_with_labels(container_name, image_tag, labels);
        return;
    }

    // Podman (and future docker-compatible runtimes): `-c LABEL` change directives.
    const args = ['commit'];
    for (const [key, value] of Object.entries(labels)) {
        // JSON.stringify yields the double-quoted, `"`/`\`-escaped token the
        // `--change "LABEL key=value"` parser expects, so a value containing a
        // quote, backslash, or newline cannot break out of the LABEL and
        // inject a further committed-image directive. Same treatment the ENV
        // block in images.ts uses; keys here are internal constants.
        args.push('-c', `LABEL ${key}=${JSON.stringify(value)}`);
    }

    args.push(container_name, image_tag);
    exec_runtime(args, { stdio: 'pipe' });
}

/**
 * nerdctl commit only supports `-c` for CMD and ENTRYPOINT — not LABEL.
 * Stage the container filesystem, then rebuild with a one-line Dockerfile
 * that applies the labels (same JSON.stringify escaping as podman `-c`).
 */
function nerdctl_commit_with_labels(
    container_name: string,
    image_tag: string,
    labels: Record<string, string>,
): void {
    const staging_tag = `patchlab/commit-staging:${crypto.randomUUID()}`;
    exec_runtime(['commit', container_name, staging_tag], { stdio: 'pipe' });
    try {
        const dockerfile_lines = [`FROM ${staging_tag}`];
        for (const [key, value] of Object.entries(labels)) {
            dockerfile_lines.push(`LABEL ${key}=${JSON.stringify(value)}`);
        }
        exec_runtime(['build', '-t', image_tag, '-f', '-', '/tmp'], {
            input: `${dockerfile_lines.join('\n')}\n`,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } finally {
        try {
            exec_runtime(['rmi', '-f', staging_tag], { stdio: 'pipe' });
        } catch (_staging_cleanup_failed) {
            /* best-effort */
        }
    }
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
