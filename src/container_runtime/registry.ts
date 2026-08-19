import type { Prompter } from '../prompts.js';
import { nerdctl_runtime } from '../nerdctl.js';
import { podman_runtime } from '../podman.js';
import { logger } from '../logger.js';
import type { Container_Runtime, Container_Runtime_Kind, Runtime_Exec_Options } from './types.js';

/**
 * Registered container runtimes, keyed by kind. Mirrors the tool-provider
 * registry in `src/tools/provider.ts` and the language-detector registry
 * in `src/languages/registry.ts`: built-ins register at module load; dispatch
 * goes through `get_active_runtime()` so adding a runtime is one registration
 * plus an auto-detect slot.
 */
const runtimes = new Map<Container_Runtime_Kind, Container_Runtime>();

/** Auto-detect order — first available runtime wins. */
const AUTO_DETECT_ORDER: Container_Runtime_Kind[] = ['nerdctl', 'podman'];

let _resolved_kind: Container_Runtime_Kind | null = null;

export function register_container_runtime(runtime: Container_Runtime): void {
    runtimes.set(runtime.kind, runtime);
}

export function get_registered_runtime(kind: Container_Runtime_Kind): Container_Runtime {
    const runtime = runtimes.get(kind);
    if (!runtime) {
        throw new Error(`Unknown container runtime: ${kind}`);
    }

    return runtime;
}

export function list_container_runtimes(): Container_Runtime[] {
    return [...runtimes.values()];
}

function resolve_runtime_kind(): Container_Runtime_Kind {
    if (_resolved_kind) {
        return _resolved_kind;
    }

    const runtime_from_env = process.env.PATCHLAB_CONTAINER_RUNTIME?.toLowerCase();
    if (runtime_from_env) {
        if (!runtimes.has(runtime_from_env as Container_Runtime_Kind)) {
            logger().error(`Unknown PATCHLAB_CONTAINER_RUNTIME: ${runtime_from_env}`);
            logger().error(`Valid values: ${[...runtimes.keys()].join(', ')}`);
            process.exit(1);
        }
        _resolved_kind = runtime_from_env as Container_Runtime_Kind;
        return _resolved_kind;
    }

    for (const kind of AUTO_DETECT_ORDER) {
        const runtime = get_registered_runtime(kind);
        if (runtime.is_available()) {
            _resolved_kind = kind;
            return kind;
        }
    }

    _resolved_kind = 'podman';
    return _resolved_kind;
}

export function get_active_runtime(): Container_Runtime {
    return get_registered_runtime(resolve_runtime_kind());
}

export function get_container_runtime(): { kind: Container_Runtime_Kind; binary: string } {
    const runtime = get_active_runtime();
    return { kind: runtime.kind, binary: runtime.get_binary() };
}

export function get_runtime_binary(): string {
    return get_active_runtime().get_binary();
}

export function get_runtime_display_name(): string {
    return get_active_runtime().display_name;
}

export function exec_runtime(args: string[], options?: Runtime_Exec_Options): Buffer | string {
    return get_active_runtime().exec(args, options);
}

export async function ensure_container_runtime(prompter: Prompter | null): Promise<void> {
    await get_active_runtime().ensure(prompter);
}

export function resolve_runtime_socket_path(): string {
    return get_active_runtime().resolve_socket_path();
}

export function image_exists(tag: string): boolean {
    return get_active_runtime().image_exists(tag);
}

export function container_exists(name: string): boolean {
    return get_active_runtime().container_exists(name);
}

/** @internal Reset cached runtime selection and all verification flags (for testing). */
export function _reset_container_runtime(): void {
    _resolved_kind = null;
    for (const runtime of runtimes.values()) {
        runtime.reset_verified();
    }
}

register_container_runtime(podman_runtime);
register_container_runtime(nerdctl_runtime);

export type { Container_Runtime_Kind, Container_Runtime, Runtime_Exec_Options } from './types.js';
