import type { Tool_Provider } from './types.js';

const VALID_NAME = /^[a-z0-9-]+$/;

/**
 * Origin of a registered provider, used by `list-tools` for source labels and
 * by `get_provider`'s unknown-tool error to group output by source.
 *
 *   - `{ kind: 'built-in' }` — code-defined provider registered at module load
 *   - `{ kind: 'user-global', manifest_path }` — synthesized from a YAML
 *     manifest under `~/.patchlab/tools/` or `~/.config/patchlab/tools/`
 *   - `{ kind: 'per-source', manifest_path, source_path }` — synthesized from
 *     a YAML manifest under `<source_path>/.patchlab/tools/`. Registered
 *     per-operation by single-target commands and gated by the first-encounter
 *     trust prompt before any launch command runs. `source_path` is included
 *     so `list-tools` and the unknown-tool error can group entries by their
 *     containing source.
 */
export type Provider_Source =
    | { kind: 'built-in' }
    | { kind: 'user-global'; manifest_path: string }
    | { kind: 'per-source'; manifest_path: string; source_path: string };

interface Registration {
    provider: Tool_Provider;
    source: Provider_Source;
}

const providers = new Map<string, Registration>();

/**
 * Register a built-in provider. Callers within `src/tools/index.ts` use this
 * at module load to register the three TypeScript-defined providers.
 */
export function register_provider(provider: Tool_Provider): void {
    register_with_source(provider, { kind: 'built-in' });
}

/**
 * Register a provider with explicit source metadata. Used by user-global and
 * per-source discovery to record the manifest path alongside the provider.
 *
 * Built-in collision behavior: a manifest-sourced registration whose `name`
 * matches an already-registered built-in is rejected unless the caller has
 * already verified `overrides_builtin: true` against the manifest. This
 * function does NOT inspect the manifest for `overrides_builtin` — that's
 * the caller's responsibility (see `register_user_global_providers` and
 * `register_per_source_manifests`).
 */
export function register_with_source(provider: Tool_Provider, source: Provider_Source): void {
    if (!VALID_NAME.test(provider.name)) {
        throw new Error(
            `Invalid provider name '${provider.name}': must match [a-z0-9-] (lowercase alphanumeric and hyphens only)`,
        );
    }
    providers.set(provider.name, { provider, source });
}

export function get_provider(name: string): Tool_Provider {
    const registration = providers.get(name);
    if (registration) {
        return registration.provider;
    }

    throw new Error(format_unknown_tool_error(name));
}

/**
 * Returns whether a provider name is currently registered. Read-only probe for
 * default-tool validation before prompting.
 */
export function is_provider_registered(name: string): boolean {
    return providers.has(name);
}

/**
 * Return all currently registered provider names. Order is registration
 * order; built-ins typically come first because `src/tools/index.ts`
 * registers them at module load before any user-global discovery runs.
 */
export function list_providers(): string[] {
    return [...providers.keys()];
}

/**
 * Return all registrations with their source metadata. Used by `list-tools`
 * to render provider source labels alongside provider names.
 */
export function list_registrations(): { name: string; provider: Tool_Provider; source: Provider_Source }[] {
    return [...providers.entries()].map(([name, registration]) => ({
        name,
        provider: registration.provider,
        source: registration.source,
    }));
}

/**
 * Look up the source for a registered provider name. Returns `null` when the
 * name isn't registered (the caller can fall through to `get_provider`'s
 * standard error). Used internally by `list-tools` and by error-message
 * builders.
 */
export function get_provider_source(name: string): Provider_Source | null {
    const registration = providers.get(name);
    return registration ? registration.source : null;
}

/**
 * Test-only: clear the registry. Production code never calls this — built-ins
 * register at module load and stay registered for the process lifetime.
 */
export function _reset_registry(): void {
    providers.clear();
}

/**
 * Drop per-source registrations from the registry, leaving built-ins and
 * user-global entries intact. Operational commands call this between source
 * paths to prevent a prior source's per-source manifests from leaking into
 * a different source's lookup. (patchlab's one-shot CLI rarely chains
 * operations, but the helper exists so future callers and tests can reset
 * cleanly.) Built-in / user-global registrations that were SHADOWED by a
 * per-source entry are NOT restored — re-running the appropriate registration
 * is the caller's responsibility.
 */
export function _drop_per_source_registrations(): void {
    const to_delete: string[] = [];
    for (const [name, registration] of providers) {
        if (registration.source.kind === 'per-source') {
            to_delete.push(name);
        }
    }

    for (const name of to_delete) {
        providers.delete(name);
    }
}

/**
 * Format the standard "unknown tool" error. Lists available tools grouped by
 * source: `built-in:` for code-defined providers, `user-global: <path>:` for
 * user-global manifest providers, `per-source: <path>:` for per-source
 * manifest providers registered for the current operation.
 */
function format_unknown_tool_error(name: string): string {
    const built_in_names: string[] = [];
    const user_global_lines: string[] = [];
    const per_source_lines: string[] = [];

    for (const [registered_name, registration] of providers) {
        if (registration.source.kind === 'built-in') {
            built_in_names.push(registered_name);
        } else if (registration.source.kind === 'user-global') {
            user_global_lines.push(`user-global: ${registration.source.manifest_path}: ${registered_name}`);
        } else {
            per_source_lines.push(`per-source: ${registration.source.manifest_path}: ${registered_name}`);
        }
    }

    const built_in_part = built_in_names.length > 0
        ? [`built-in: ${built_in_names.join(', ')}`]
        : [];
    const parts: string[] = [...built_in_part, ...user_global_lines, ...per_source_lines];

    return (parts.length === 0)
        ? `Unknown tool '${name}'. No providers registered.`
        : `Unknown tool '${name}'. Available tools:\n  ${parts.join('\n  ')}`;
}
