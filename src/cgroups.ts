/**
 * Host-side cgroup capability probe and the warn-once helper that surfaces
 * a missing-controller diagnostic.
 *
 * Rootless Podman silently no-ops `--memory` and `--cpus` when cgroup v2's
 * `memory` and `cpu` controllers are not delegated. The container is created,
 * the flags are recorded, but no enforcement happens. The probe inspects
 * `/sys/fs/cgroup<path>/cgroup.controllers` to detect that state and the
 * warn-once helper emits a developer-facing warning before the first
 * `podman create` so users don't get false confidence in the limits.
 *
 * On macOS and Windows, sandboxes run inside a Podman machine VM that has
 * cgroup v2 controllers available. The probe short-circuits to "supported"
 * on non-Linux without any filesystem access.
 *
 * One probe per process; one warning per process. The result is cached at
 * module level; subsequent probe calls return the cache directly. Tests can
 * reset the cache through the dedicated test-only export below.
 */
import * as fs from 'node:fs';
import { logger } from './logger.js';

export interface Cgroup_Probe_Result_Supported {
    supported: true;
    /** Short token identifying why the probe returned supported. */
    reason: 'non-linux' | 'controllers-present';
}

export interface Cgroup_Probe_Result_Unsupported {
    supported: false;
    /** Human-readable reason for the unsupported result; safe to surface in user-facing warnings. */
    reason: string;
}

export type Cgroup_Probe_Result = Cgroup_Probe_Result_Supported | Cgroup_Probe_Result_Unsupported;

const PROC_SELF_CGROUP = '/proc/self/cgroup';
const SYS_FS_CGROUP_ROOT = '/sys/fs/cgroup';

let cached_probe_result: Cgroup_Probe_Result | null = null;
let warning_emitted_in_this_process = false;

/**
 * Probe the host's cgroup configuration. Cached at module level after the
 * first call. The probe never throws; filesystem errors collapse to
 * `{ supported: false, reason }`.
 *
 * Implementation note: on Linux, parses the unified-hierarchy line (the one
 * beginning with `0::`) out of `/proc/self/cgroup`, then reads the
 * controllers file at the resolved path. A pure cgroup-v1 host has no `0::`
 * line and is reported as unsupported — patchlab does not attempt cgroup v1
 * support; the rootless story we care about is v2 only.
 */
export function probe_cgroup_capabilities(): Cgroup_Probe_Result {
    if (cached_probe_result !== null) {
        return cached_probe_result;
    }

    if (process.platform !== 'linux') {
        cached_probe_result = { supported: true, reason: 'non-linux' };
        return cached_probe_result;
    }

    cached_probe_result = probe_linux_cgroup_v2();
    return cached_probe_result;
}

function probe_linux_cgroup_v2(): Cgroup_Probe_Result {
    let proc_self_cgroup: string;
    try {
        proc_self_cgroup = fs.readFileSync(PROC_SELF_CGROUP, 'utf-8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { supported: false, reason: `could not read ${PROC_SELF_CGROUP}: ${message}` };
    }

    const unified_path = parse_unified_cgroup_path(proc_self_cgroup);
    if (unified_path === null) {
        return {
            supported: false,
            reason: `${PROC_SELF_CGROUP} has no cgroup v2 unified hierarchy line (no "0::" entry); `
                + `patchlab requires cgroup v2 for resource-limit enforcement`,
        };
    }

    const controllers_file = `${SYS_FS_CGROUP_ROOT}${unified_path}/cgroup.controllers`;
    let controllers_contents: string;
    try {
        controllers_contents = fs.readFileSync(controllers_file, 'utf-8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { supported: false, reason: `could not read ${controllers_file}: ${message}` };
    }

    const controllers = new Set(controllers_contents.trim().split(/\s+/).filter((token) => token.length > 0));
    const missing: string[] = [];
    if (!controllers.has('memory')) {
        missing.push('memory');
    }

    if (!controllers.has('cpu')) {
        missing.push('cpu');
    }

    return (missing.length > 0) ? {
            supported: false,
            reason: `missing required cgroup v2 controllers: ${missing.join(', ')} `
                + `(found: ${controllers_contents.trim() || '<empty>'})`,
        } : { supported: true, reason: 'controllers-present' };
}

function parse_unified_cgroup_path(proc_self_cgroup_contents: string): string | null {
    // Each line is `hierarchy_id:controller_list:cgroup_path`. The cgroup v2
    // unified hierarchy uses `hierarchy_id=0` with an empty controller list,
    // producing the literal `0::<path>` form. A pure cgroup-v1 host has only
    // `N:controller:path` lines and is rejected by the absent-`0::` check.
    for (const line of proc_self_cgroup_contents.split('\n')) {
        if (line.startsWith('0::')) {
            return line.substring(3);
        }
    }

    return null;
}

/**
 * Emit the developer-facing cgroup-unsupported warning exactly once per
 * process. Subsequent calls in the same process are no-ops.
 *
 * The warning text covers four required elements: the user-visible
 * consequence, the cause in plain terms, an actionable documentation link,
 * and reassurance that sandbox creation will continue. It is routed through
 * `logger().warn` (NOT `console.warn` and NOT `process.stderr.write`) so the
 * Logger surface remains the single channel for all user-facing output —
 * see the migration-invariant test.
 *
 * Cross-process suppression is intentionally out of scope: two concurrent
 * `patchlab create` shells against the same unsupported host each emit one
 * warning. The persistence cost (a marker file with TTL and race-free
 * updates) isn't worth the savings for a developer-facing diagnostic.
 */
export function warn_once_if_unsupported(): void {
    if (warning_emitted_in_this_process) {
        return;
    }

    const probe = probe_cgroup_capabilities();
    if (probe.supported) {
        return;
    }

    warning_emitted_in_this_process = true;
    logger().warn(build_cgroup_warning_message());
}

function build_cgroup_warning_message(): string {
    return [
        "warning: this host's rootless Podman cannot enforce memory or CPU limits",
        '  on patchlab sandboxes. A runaway tool inside a sandbox can still consume',
        '  all host resources. To enable enforcement, see:',
        '    https://github.com/Training-Datasmith/patchlab/blob/main/documents/configuration.md#cgroup-delegation',
        '  (Sandbox creation will continue with limits set but unenforced.)',
    ].join('\n');
}

/**
 * Reset the module-level probe cache and warn-once latch. Test-only — used by
 * `beforeEach` hooks that need a fresh state between cases. Not exported via
 * the public capability surface; production code SHALL NOT call this.
 */
export function _reset_cgroup_probe_state_for_tests(): void {
    cached_probe_result = null;
    warning_emitted_in_this_process = false;
}