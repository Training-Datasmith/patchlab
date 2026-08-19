import * as path from 'node:path';
import { register_provider, register_with_source, get_provider_source } from './provider.js';
import { logger } from '../logger.js';
import { create_opencode_provider, OPENCODE_TOOL_NAME } from '../opencode/index.js';
import {
    Configured_Tool_Provider,
    type Configured_Tool_Provider_Manifest,
    type Manifest_Parse_Error,
    discover_user_global_manifest_paths,
    format_warning,
    read_and_parse_manifest,
    assert_no_within_scope_name_conflicts,
    assert_host_path_within_source,
    parse_manifest_from_buffer,
    read_per_source_manifest_buffers,
} from './configured_provider/index.js';

// Built-in providers are registered here at module load.
register_provider(create_opencode_provider());

function is_registered_builtin(name: string): boolean {
    return get_provider_source(name)?.kind === 'built-in';
}

/**
 * Discover user-global manifests (`~/.patchlab/tools/`,
 * `~/.config/patchlab/tools/`), parse each, and register the synthesized
 * provider with the registry.
 *
 * Two modes:
 *
 *  - `'abort-on-error'` (default): parse failures, built-in collisions without
 *    `overrides_builtin: true`, and within-scope name conflicts throw. This is
 *    the form operational commands rely on so a broken manifest fails fast
 *    before any container work begins.
 *  - `'collect-and-skip'`: the same failures are collected into a returned
 *    `Manifest_Parse_Error[]` and the affected manifests are skipped. Well-
 *    formed manifests still register. Used by `list-tools`, which is a
 *    diagnostic command that must keep listing well-formed providers even when
 *    some manifests are broken.
 *
 * Module-load runs in collect-and-skip mode (so importing this module never
 * aborts startup); operational commands re-validate by calling
 * `validate_user_global_or_abort()` at the top of their handler. The first
 * collect-and-skip pass populates the registry with what works; the strict
 * re-pass throws on any error that would otherwise have aborted at module
 * load. Idempotent — re-registering the same well-formed manifests is a no-op
 * because `register_with_source` keys on `name`.
 */
export interface Register_User_Global_Options {
    mode?: 'abort-on-error' | 'collect-and-skip';
}

export interface Register_User_Global_Result {
    errors: Manifest_Parse_Error[];
}

type Mode = 'abort-on-error' | 'collect-and-skip';

function validate_user_global_manifest(
    manifest_path: string,
    mode: Mode,
    errors: Manifest_Parse_Error[],
): { manifest: Configured_Tool_Provider_Manifest; manifest_path: string } | null {
    const parsed = read_and_parse_manifest(manifest_path);
    if ('field_path' in parsed) {
        if (mode === 'abort-on-error') {
            logger().error(format_warning({
                operation: 'register_user_global',
                provider_name: parsed.manifest_path,
                action: 'rejected',
                target: parsed.field_path === '' ? parsed.manifest_path : parsed.field_path,
                reason: parsed.reason,
            }));
            throw new Error(`Aborting startup: invalid manifest at ${parsed.manifest_path}`);
        }

        errors.push(parsed);
        return null;
    }

    if (is_registered_builtin(parsed.name) && parsed.overrides_builtin === false) {
        if (mode === 'abort-on-error') {
            throw new Error(
                `Configured provider '${parsed.name}' at ${manifest_path} conflicts with a built-in. `
                + `Set 'overrides_builtin: true' in the manifest to shadow the built-in, `
                + `or rename the configured provider.`,
            );
        }

        errors.push({
            manifest_path,
            field_path: 'overrides_builtin',
            reason:
                `configured provider '${parsed.name}' conflicts with a built-in. `
                + `Set 'overrides_builtin: true' in the manifest to shadow the built-in, `
                + `or rename the configured provider.`,
        });

        return null;
    }

    return { manifest: parsed, manifest_path };
}

function dedupe_user_global_collect(
    entries: { manifest: Configured_Tool_Provider_Manifest; manifest_path: string }[],
    errors: Manifest_Parse_Error[],
): { manifest: Configured_Tool_Provider_Manifest; manifest_path: string }[] {
    const name_first_seen = new Map<string, string>();
    const survivors: { manifest: Configured_Tool_Provider_Manifest; manifest_path: string }[] = [];
    for (const entry of entries) {
        const earlier = name_first_seen.get(entry.manifest.name);
        if (earlier === undefined) {
            name_first_seen.set(entry.manifest.name, entry.manifest_path);
            survivors.push(entry);
            continue;
        }
        errors.push({
            manifest_path: entry.manifest_path,
            field_path: 'name',
            reason:
                `name conflict at user-global scope: '${entry.manifest.name}' is already declared by ${earlier}. `
                + `Skipping this manifest`,
        });
    }

    return survivors;
}

export function register_user_global_providers(
    options?: Register_User_Global_Options,
): Register_User_Global_Result {
    const mode = options?.mode ?? 'abort-on-error';
    const manifest_paths = discover_user_global_manifest_paths();
    if (manifest_paths.length === 0) {
        return { errors: [] };
    }

    const errors: Manifest_Parse_Error[] = [];
    let parsed_entries: { manifest: Configured_Tool_Provider_Manifest; manifest_path: string }[] = [];

    for (const manifest_path of manifest_paths) {
        const entry = validate_user_global_manifest(manifest_path, mode, errors);
        if (entry !== null) {
            parsed_entries.push(entry);
        }
    }

    if (mode === 'abort-on-error') {
        assert_no_within_scope_name_conflicts(parsed_entries);
    } else {
        parsed_entries = dedupe_user_global_collect(parsed_entries, errors);
    }

    for (const entry of parsed_entries) {
        const provider = new Configured_Tool_Provider(entry.manifest, entry.manifest_path);
        register_with_source(provider, { kind: 'user-global', manifest_path: entry.manifest_path });
    }

    return { errors };
}

// Module-load registration runs in collect-and-skip mode so importing this
// module never aborts startup (`list-tools` must still run when a user-global
// manifest is broken). Operational commands call `validate_user_global_or_abort`
// at the top of their handler to enforce the strict failure-fast contract.
const module_load_result: Register_User_Global_Result = register_user_global_providers({
    mode: 'collect-and-skip',
});

/**
 * Strict re-validation entry point for operational commands. Replays the
 * collect-and-skip results stored at module load: if any manifest failed to
 * parse, collided with a built-in, or had a name conflict, throws so the
 * operation aborts before doing any container work. Idempotent.
 *
 * `list-tools` does NOT call this — it intentionally tolerates broken
 * manifests, rendering them through `format_warning(...)` instead.
 */
export function validate_user_global_or_abort(): void {
    if (module_load_result.errors.length === 0) {
        return;
    }
    const first = module_load_result.errors[0];
    logger().error(format_warning({
        operation: 'register_user_global',
        provider_name: first.manifest_path,
        action: 'rejected',
        target: first.field_path === '' ? first.manifest_path : first.field_path,
        reason: first.reason,
    }));
    throw new Error(`Aborting: invalid user-global manifest at ${first.manifest_path}`);
}

/**
 * Return the parse/collision errors collected by the module-load pass. Used
 * by `list-tools` to render warnings inline alongside well-formed providers.
 */
export function get_user_global_load_errors(): Manifest_Parse_Error[] {
    return module_load_result.errors.slice();
}

export interface Per_Source_Registration_Result {
    /**
     * Parse, containment, and collision errors encountered during registration.
     * Each error is `Manifest_Parse_Error`-shaped so callers can render them
     * uniformly via `format_warning(...)`.
     */
    errors: Manifest_Parse_Error[];
    /**
     * Map of manifest_path → file bytes captured during the one-shot read.
     * The same map is passed to `compute_trusted_manifests_hash` so the bytes
     * the user trusts (via the hash) are byte-identical to the bytes that
     * registration parsed and dispatched. Closes the TOCTOU gap between hash
     * and parse.
     */
    manifest_buffers: Map<string, Buffer>;
    /**
     * The parsed manifests that survived validation and were registered. Used
     * by `confirm_per_source_manifests` to disclose the launch commands, base
     * images, authentication methods, and dockerfile install lists to the
     * user at the trust prompt.
     */
    registered_manifests: Configured_Tool_Provider_Manifest[];
    /**
     * Parallel array to `registered_manifests`: the i-th entry is the
     * `repository_root` that the i-th registered manifest came from. Used by
     * the multi-repository trust fan-out to partition manifests per repository
     * when presenting per-repository trust prompts. The arrays are kept parallel
     * (rather than fused into one object) so existing callers that only need
     * `registered_manifests` are unaffected.
     */
    registered_manifest_repositories: string[];
}

/**
 * Discover, validate, and register per-source manifests under
 * `<source_path>/.patchlab/tools/`. Operation-invoked (NOT a module-load side
 * effect): single-target CLI commands call this at the start of their action,
 * BEFORE `get_provider(tool_name)` resolves the configured tool.
 *
 * Steps for each manifest:
 *   1. Read into a buffer ONCE (shared with the trust hash to close TOCTOU)
 *   2. Decode + parse via `parse_manifest_from_buffer`
 *   3. For `file_copy` authentication, run `assert_host_path_within_source`
 *      against every `authentication.copies[*].host` — per-source manifests
 *      cannot copy files from outside the source tree
 *   4. Reject built-in collisions without `overrides_builtin: true`
 *   5. Reject within-scope name conflicts (first wins; later duplicates are
 *      reported as parse errors and skipped)
 *
 * Registration is read-only with respect to trust state — it does NOT prompt
 * for confirmation, does NOT write the marker, and does NOT block. The trust
 * gate fires at the operation level after registration succeeds (see
 * `verify_per_source_trust` in `configured_provider/trust_verification.ts`).
 *
 * Cross-scope precedence: per-source REPLACES any user-global registration of
 * the same name for the duration of the process (the registry is a Map keyed
 * by name; the later `register_with_source` call overwrites). Built-ins still
 * require explicit `overrides_builtin: true` from the manifest.
 */
interface Parsed_Entry {
    manifest: Configured_Tool_Provider_Manifest;
    manifest_path: string;
    /**
     * The repository whose `.patchlab/tools/` directory contains this
     * manifest. Used by the cross-repository collision detector to identify which
     * repos a colliding name came from.
     */
    repository_root: string;
}

function validate_per_source_manifest(
    buffer: Buffer,
    manifest_path: string,
    repository_root: string,
): Parsed_Entry | Manifest_Parse_Error {
    const parsed = parse_manifest_from_buffer(buffer, manifest_path);
    if ('field_path' in parsed) {
        return parsed;
    }

    if (parsed.authentication.method === 'file_copy') {
        for (let index = 0; index < parsed.authentication.copies.length; index++) {
            const containment_error = assert_host_path_within_source(
                parsed.authentication.copies[index].host,
                repository_root,
                manifest_path,
                { field_index: index },
            );
            if (containment_error) {
                return containment_error;
            }
        }
    }

    if (is_registered_builtin(parsed.name) && parsed.overrides_builtin === false) {
        return {
            manifest_path,
            field_path: 'overrides_builtin',
            reason:
                `configured provider '${parsed.name}' conflicts with a built-in. `
                + `Set 'overrides_builtin: true' in the manifest to shadow the built-in, `
                + `or rename the configured provider.`,
        };
    }

    return { manifest: parsed, manifest_path, repository_root };
}

/**
 * Hard-fail error for name collisions across per-source manifests. The
 * collision can be intra-scope (two manifests in the same repository's
 * `.patchlab/tools/` declaring the same `name`) or cross-scope (two
 * repositories' `.patchlab/tools/` directories each declaring the same
 * `name`). Both forms are rejected at registration per the
 * `configured-tool-provider` spec — silently picking one would let a
 * hostile manifest shadow a legitimate tool.
 */
export class Manifest_Collision_Error extends Error {
    constructor(
        public readonly conflicting_name: string,
        public readonly entries: readonly { manifest_path: string; repository_root: string }[],
        public readonly scope: 'intra-scope' | 'cross-scope',
    ) {
        super(format_collision_message(conflicting_name, entries, scope));
    }
}

function format_collision_message(
    conflicting_name: string,
    entries: readonly { manifest_path: string; repository_root: string }[],
    scope: 'intra-scope' | 'cross-scope',
): string {
    const heading = scope === 'intra-scope'
        ? `Two manifests in the same repository declare name '${conflicting_name}'.`
        : `Two repositories' per-source manifests declare the same name '${conflicting_name}'.`;
    const lines: string[] = [heading];
    if (scope === 'cross-scope') {
        const repository_paths = Array.from(new Set(entries.map((entry) => entry.repository_root)));
        lines.push(`Conflicting repositories:`);
        for (const repository_root of repository_paths) {
            lines.push(`  - ${repository_root}`);
        }
        lines.push(`Conflicting manifests:`);
    } else {
        lines.push(`Repository: ${entries[0].repository_root}`, `Conflicting manifests:`);
    }

    for (const entry of entries) {
        lines.push(`  - ${entry.manifest_path}`);
    }

    if (scope === 'cross-scope') {
        lines.push(
            `Resolution: rename one of the conflicting manifests, OR move the shared `
            + `tool to a user-global manifest at ~/.patchlab/tools/${conflicting_name}.yaml `
            + `(user-global manifests are not subject to per-source containment or `
            + `cross-repository collision rules).`,
        );
    } else {
        lines.push(
            `Resolution: rename one of the conflicting manifests so each `
            + `'name' is unique within the repository.`,
        );
    }

    return lines.join('\n');
}

/**
 * Detect name collisions across the combined set of parsed per-source entries.
 * Intra-scope collisions (two manifests in the same repository declaring the same
 * name) are surfaced separately from cross-scope collisions (two repos
 * declaring the same name). Both forms throw `Manifest_Collision_Error` — the
 * spec says both fail registration. The intra-scope-first ordering reports
 * the more local conflict before the cross-repository one when both exist.
 */
function detect_name_collisions(entries: readonly Parsed_Entry[]): void {
    const by_name = new Map<string, Parsed_Entry[]>();
    for (const entry of entries) {
        const list = by_name.get(entry.manifest.name) ?? [];
        list.push(entry);
        by_name.set(entry.manifest.name, list);
    }
    for (const [name, list] of by_name) {
        if (list.length < 2) {
            continue;
        }
        const repositories = new Set(list.map((entry) => entry.repository_root));
        const scope: 'intra-scope' | 'cross-scope' = repositories.size === 1 ? 'intra-scope' : 'cross-scope';
        const ordered = scope === 'intra-scope'
            ? list.slice().sort((a, b) => path.basename(a.manifest_path).localeCompare(path.basename(b.manifest_path)))
            : list;
        throw new Manifest_Collision_Error(name, ordered.map((entry) => ({
            manifest_path: entry.manifest_path,
            repository_root: entry.repository_root,
        })), scope);
    }
}

/**
 * Discover, validate, and register per-source manifests across one or more
 * repositories. For each repository, scans `<repository_root>/.patchlab/tools/`
 * for `*.yaml` / `*.yml` files; parses each; runs per-manifest containment
 * checks against that manifest's specific repository (so a manifest in
 * `/repository-a/.patchlab/tools/` cannot reach into `/repository-b/...` even when the
 * patchlab also mounts `/repository-b`). After per-repository validation, detects name
 * collisions across the union: intra-scope (within one repository) and cross-scope
 * (between repos) both throw `Manifest_Collision_Error`. If no collisions,
 * registers every survivor.
 *
 * Single-repository callers pass a one-element array; the behavior collapses to the
 * pre-multi-source-trust path byte-for-byte (one repository's read+validate+register,
 * with the intra-scope collision check now a hard-fail per the spec
 * reconciliation).
 */
export function register_per_source_manifests(
    repository_roots: readonly string[],
): Per_Source_Registration_Result {
    const errors: Manifest_Parse_Error[] = [];
    const manifest_buffers = new Map<string, Buffer>();
    const parsed_entries: Parsed_Entry[] = [];

    for (const repository_root of repository_roots) {
        const per_repository_buffers = read_per_source_manifest_buffers(repository_root);
        for (const [manifest_path, buffer] of per_repository_buffers) {
            manifest_buffers.set(manifest_path, buffer);
            const result = validate_per_source_manifest(buffer, manifest_path, repository_root);
            if ('field_path' in result) {
                errors.push(result);
                continue;
            }
            parsed_entries.push(result);
        }
    }

    detect_name_collisions(parsed_entries);

    for (const entry of parsed_entries) {
        const provider = new Configured_Tool_Provider(
            entry.manifest,
            entry.manifest_path,
            entry.repository_root,
        );
        register_with_source(provider, {
            kind: 'per-source',
            manifest_path: entry.manifest_path,
            source_path: entry.repository_root,
        });
    }

    return {
        errors,
        manifest_buffers,
        registered_manifests: parsed_entries.map((entry) => entry.manifest),
        registered_manifest_repositories: parsed_entries.map((entry) => entry.repository_root),
    };
}

/**
 * Test/teardown helper: drop all per-source registrations from the registry.
 * Re-exported from `provider.ts` so callers don't need to know the internal
 * module boundary.
 */
export { _drop_per_source_registrations } from './provider.js';

// Re-export API
export {
    register_provider,
    register_with_source,
    get_provider,
    list_providers,
    list_registrations,
    get_provider_source,
} from './provider.js';
export type { Provider_Source } from './provider.js';
import type { Launch_Context, Prompt_Passthrough_Capability, Tool_Provider } from './types.js';
export type {
    Authentication_Method,
    Authentication_Result,
    Host_Access_Plan,
    Host_File_Copy,
    Image_Specification,
    Launch_Context,
    Prepare_Host_Access_Context,
    Prompt_Launch_Context,
    Prompt_Passthrough_Capability,
    Tool_Provider,
} from './types.js';
export { HOST_PATCHLAB_INTERNAL } from './types.js';
export { Configured_Tool_Provider, format_warning } from './configured_provider/index.js';
export type { Manifest_Parse_Error } from './configured_provider/index.js';

export function provider_supports_prompt_launch(provider: Tool_Provider): boolean {
    return provider.get_prompt_launch_command !== undefined;
}

export function provider_supports_prompt_passthrough(
    provider: Tool_Provider,
    capability: Prompt_Passthrough_Capability,
): boolean {
    const capabilities = provider.get_prompt_passthrough_capabilities?.();
    return capabilities !== undefined && capabilities.includes(capability);
}

function assert_passthrough_inputs(provider: Tool_Provider, context?: Launch_Context): void {
    const extra = context?.extra_argv;
    if (extra !== undefined && extra.length > 0
        && !provider_supports_prompt_passthrough(provider, 'passthrough')) {
        throw new Error(`tool '${provider.name}' does not support --passthrough`);
    }
    const files = context?.files;
    if (files !== undefined && files.length > 0
        && !provider_supports_prompt_passthrough(provider, 'file')) {
        throw new Error(`tool '${provider.name}' does not support --prompt-file`);
    }
}

/**
 * Container path where patchlab stages source files inside any provider's image.
 * The path is provider policy: each provider declares `image_home`, and patchlab
 * lands its workspace at `${image_home}/workspace`. Centralized here so every
 * call site routes through one function and the policy cannot drift.
 */
export function compute_container_workspace_path(provider: Tool_Provider): string {
    return `${provider.image_specification.image_home}/workspace`;
}

/**
 * Resolve the argv patchlab should exec inside the container. Without a prompt,
 * returns `get_launch_command()`. With a prompt, requires `get_prompt_launch_command`.
 */
export function resolve_tool_launch_command(
    provider: Tool_Provider,
    prompt: string | undefined,
    context?: Launch_Context,
): string[] {
    assert_passthrough_inputs(provider, context);
    if (prompt === undefined) {
        return provider.get_launch_command(context);
    }
    if (provider.get_prompt_launch_command === undefined) {
        throw new Error(`tool '${provider.name}' does not support --prompt`);
    }
    return provider.get_prompt_launch_command(prompt, context);
}

export { resolve_create_tool_name, resolve_create_tool_provider, DEFAULT_BUILTIN_TOOL } from './default_tool.js';
export type { Per_Source_Default_Tool_Resolution } from './default_tool.js';
export {
    verify_per_source_default_tool,
    resolve_allow_untrusted_default_tool_from,
    Default_Tool_Aborted_Error,
    Default_Tool_Declined_Error,
    Conflicting_Default_Tools_Error,
} from './default_tool_trust.js';
export {
    read_default_tool_preference,
    write_default_tool_preference,
    default_tool_preference_path,
    default_tool_preference_directory,
} from './default_tool_preference.js';
export { repository_realpath, repository_state_key } from './repository_state_key.js';
export { is_provider_registered } from './provider.js';
export { OPENCODE_TOOL_NAME } from '../opencode/index.js';
