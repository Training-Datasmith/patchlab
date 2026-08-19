/**
 * Top-level configuration file loader for `~/.patchlab/configuration.yaml`
 * (user-global) and `<source>/.patchlab/configuration.yaml` (per-source).
 *
 * The v1 schema accepts exactly one top-level key, `resource_limits`, with the
 * four field subset documented by `sandbox-resource-limits`. The loader does
 * parse-time validation only — schema, types, ranges, unknown keys — and
 * returns a typed `Loaded_Configuration`. Per-source clamping happens in the
 * resolver where the user-global value is also visible.
 *
 * On-disk vs in-memory naming. The YAML keys are bare (`memory`, `cpus`,
 * `pids`, `blkio_weight`); the TS-side fields use the `_limit` suffix
 * convention shared with `Persisted_Resource_Limits` / `Resolved_Resource_Limits`
 * for readability at access sites. The single source of truth for that
 * field-name mapping is `RESOURCE_LIMIT_FIELD_MAP` below; both the
 * YAML→TS conversion in this file and the inverse direction used at manifest
 * write time read from that one table so a future field rename cannot drift
 * between read and write paths.
 *
 * Missing files are NOT errors. A file that exists but contains no
 * `resource_limits` key is also not an error — it is treated as "no settings
 * here, fall through" (the path future top-level keys will use). Any other
 * malformation aborts loading WITHOUT partial application.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import {
    RESOURCE_LIMIT_FIELD_MAP,
    UNLIMITED,
    type Unlimited,
} from './resource_limits.js';
import { is_plain_object } from './json_validators.js';
import { logger } from './logger.js';
import type { Loaded_OpenCode_Settings } from './opencode/settings.js';
import { OPENCODE_TOOL_NAME } from './opencode/index.js';

/** User-global tool-specific configuration blocks, keyed by tool name. */
export type Loaded_Tool_Configuration = Readonly<
    Record<string, Readonly<Record<string, unknown>>>
>;

/**
 * Parsed contents of one configuration file on disk.
 */
export interface Parsed_Configuration_File {
    resource_limits: Loaded_Resource_Limits;
    default_tool: string | null;
    tool_configuration: Record<string, Partial<Loaded_OpenCode_Settings>> | null;
}

/**
 * Per-field loaded shape. Each field is `value | "unlimited" | null` where
 * `null` means "field not set in this file" (fall through to lower precedence)
 * and `"unlimited"` means "explicitly unlimited" (originating from a YAML `0`
 * for `memory`/`cpus`/`pids`). `blkio_weight` has no unlimited form so the
 * sentinel is only `null`-or-number.
 */
export interface Loaded_Resource_Limits {
    memory_limit: string | Unlimited | null;
    cpu_limit: string | Unlimited | null;
    pids_limit: number | Unlimited | null;
    blkio_weight: number | null;
}

/**
 * Pair of optional loaded configurations — the user-global file and the
 * per-source file. Either or both MAY be `null` (file absent or absent-equivalent
 * — broken symlink, directory symlink, no `resource_limits` key in a file that
 * parsed cleanly).
 */
export interface Loaded_Configuration {
    user_global: Loaded_Resource_Limits | null;
    per_source: Loaded_Resource_Limits | null;
    /** User-global default tool name; null falls through to built-in OpenCode. */
    default_tool: string | null;
    /** User-global tool-specific configuration, keyed by tool name. */
    tool_configuration: Loaded_Tool_Configuration;
    /**
     * Per-repository `default_tool` values from each repo's configuration.yaml
     * (pre-trust). Keyed by `repository_root`. Repositories that omit the field
     * are absent from this map.
     */
    per_repository_default_tools: Readonly<Record<string, string>>;
}

const ACCEPTED_YAML_KEYS = new Set<string>(
    RESOURCE_LIMIT_FIELD_MAP.map((entry) => entry.on_disk_key),
);

const ACCEPTED_TOP_LEVEL_KEYS = new Set<string>(['resource_limits', 'default_tool', 'tool_configuration']);

const KNOWN_TOOL_CONFIGURATION_TOOLS = new Set<string>([OPENCODE_TOOL_NAME]);

const OPENCODE_SETTINGS_KEYS = new Set<string>([
    'copy_host_configuration',
    'copy_host_auth',
    'proxy_local_models',
    'environment',
]);

/** 64 KiB — well above any realistic v1 configuration (which fits in <200 bytes). */
export const CONFIGURATION_FILE_SIZE_CAP_BYTES = 64 * 1024;

const MAX_PIDS = 2 ** 31 - 1;

/**
 * Resolve the user-global configuration path. `PATCHLAB_HOME` overrides the
 * default home-directory root when set and non-empty, matching the precedent
 * established by `trust_marker_directory` in `src/tools/configured_provider/trust_marker.ts`.
 */
export function user_global_configuration_path(): string {
    const override = process.env.PATCHLAB_HOME;
    const home = override !== undefined && override !== '' ? override : os.homedir();
    return path.join(home, '.patchlab', 'configuration.yaml');
}

/**
 * Resolve the per-source configuration path for a given repository root.
 * Under the single-repository invariant established by `sandbox-lifecycle`,
 * every patchlab has exactly one repository root regardless of how many
 * sources it mounts; the per-source configuration file lives at
 * `<repository_root>/.patchlab/configuration.yaml`. The function name keeps
 * the legacy "per-source" label for back-compat with documentation; the
 * semantic is per-repository.
 */
export function per_source_configuration_path(repository_root: string): string {
    return path.join(repository_root, '.patchlab', 'configuration.yaml');
}

/**
 * Load the user-global configuration file plus every repository's per-source
 * file, composing the per-source values across repositories via a lattice
 * min-fold (the most-restrictive value wins per field — see
 * `compose_per_source_loaded_resource_limits` for the lattice rules).
 *
 * The caller passes the distinct repositories the patchlab spans, in
 * `manifest_repositories(manifest)` first-appearance order. Single-repository
 * patchlabs pass a one-element array; the composition collapses to that one
 * repository's per-source value byte-for-byte, matching the pre-multi-source-trust
 * behavior.
 *
 * Repositories whose per-source file is absent (or absent-equivalent: broken
 * symlink, symlink-to-directory) contribute `null` for every field, which is
 * excluded from the per-field min-fold. A field whose every contributing repository
 * is `null` ends up `null` in the composite (falls through to user-global per
 * the existing precedence ladder).
 *
 * Missing files are NOT errors. Any other malformation (oversized file,
 * malformed YAML, schema violation, out-of-range value) throws — partial
 * loads are never applied. Callers surface thrown errors as CLI-level
 * failures with non-zero exit (see `load_configuration_or_exit` in cli.ts);
 * this function does not catch its own throws.
 *
 * Per-repository clamping against the user-global / default upper bound is NOT
 * performed here — the resolver applies that clamp in
 * `resolve_concrete_or_unlimited_field` against the composite per-source
 * value. Mathematically the orderings (clamp-then-fold vs fold-then-clamp)
 * are equivalent because `clamp(x, B) = min(x, B)`: `min(clamp(a, B), clamp(b, B)) = min(a, b, B) = clamp(min(a, b), B)`.
 * The fold-then-clamp ordering avoids the layering violation of the loader
 * reaching into the resolver's `runtime_default`.
 */
export function load_configuration(repository_roots: readonly string[]): Loaded_Configuration {
    const user_global_parsed = load_full_configuration_file(user_global_configuration_path());
    const per_repository_limits: (Loaded_Resource_Limits | null)[] = [];
    const per_repository_default_tools: Record<string, string> = {};

    for (const repository_root of repository_roots) {
        const parsed = load_full_configuration_file(per_source_configuration_path(repository_root));
        if (parsed !== null) {
            warn_ignored_per_source_tool_configuration(parsed, per_source_configuration_path(repository_root));
            if (parsed.default_tool !== null) {
                per_repository_default_tools[repository_root] = parsed.default_tool;
            }
        }

        per_repository_limits.push(parsed?.resource_limits ?? null);
    }

    const per_source = compose_per_source_loaded_resource_limits(per_repository_limits, repository_roots);

    const user_global_limits = user_global_parsed?.resource_limits ?? null;
    const default_tool = user_global_parsed?.default_tool ?? null;
    const tool_configuration = normalize_loaded_tool_configuration(
        user_global_parsed?.tool_configuration ?? null,
    );

    return {
        user_global: user_global_limits,
        per_source,
        default_tool,
        tool_configuration,
        per_repository_default_tools,
    };
}

/**
 * Build a `Loaded_Configuration` for tests and resolver call sites that only
 * care about resource limits.
 */
export function loaded_configuration_with_resource_limits(
    user_global: Loaded_Resource_Limits | null,
    per_source: Loaded_Resource_Limits | null,
    overrides?: {
        default_tool?: string | null;
        tool_configuration?: Loaded_Tool_Configuration | null;
        per_repository_default_tools?: Readonly<Record<string, string>>;
    },
): Loaded_Configuration {
    return {
        user_global,
        per_source,
        default_tool: overrides?.default_tool ?? null,
        tool_configuration: normalize_loaded_tool_configuration(
            overrides?.tool_configuration ?? null,
        ),
        per_repository_default_tools: overrides?.per_repository_default_tools ?? {},
    };
}

function normalize_loaded_tool_configuration(
    parsed: Record<string, Partial<Loaded_OpenCode_Settings>> | Loaded_Tool_Configuration | null,
): Loaded_Tool_Configuration {
    if (parsed === null) {
        return {};
    }

    const loaded: Record<string, Readonly<Record<string, unknown>>> = {};
    for (const [tool_name, block] of Object.entries(parsed)) {
        loaded[tool_name] = { ...block };
    }

    return loaded;
}

function warn_ignored_per_source_tool_configuration(
    parsed: Parsed_Configuration_File,
    file_path: string,
): void {
    if (parsed.tool_configuration !== null) {
        logger().verbose(
            `Ignoring per-source tool_configuration in ${file_path}; `
            + `configure tools under tool_configuration in ~/.patchlab/configuration.yaml instead.`,
        );
    }
}

/**
 * Lattice min-fold across N repositories' per-source resource-limit values.
 *
 * Per field, the lattice ordering is:
 * - A concrete numeric value is a regular lattice element.
 * - The sentinel `"unlimited"` is the TOP (least restrictive). Any concrete
 *   value is more restrictive than `"unlimited"`.
 * - `null` (field not set in this repository) excludes that repository from the per-field
 *   fold. Null is NOT bottom — it's exclusion.
 *
 * If every contributing repository says `null` for a field, the field stays `null`
 * in the composite. If at least one supplies a value, the composite is the
 * min over the participating values (concrete wins over `"unlimited"`;
 * smallest concrete wins among concretes; all-unlimited folds to `"unlimited"`).
 *
 * Single-repository (N=1) collapses to the one repository's value byte-for-byte. If every
 * per-repository entry is `null` (no per-source file in any repository), the function
 * returns `null` so the resolver sees "no per-source layer."
 */
export function compose_per_source_loaded_resource_limits(
    per_repository: readonly (Loaded_Resource_Limits | null)[],
    repository_roots: readonly string[],
): Loaded_Resource_Limits | null {
    const has_any = per_repository.some((entry) => entry !== null);
    if (!has_any) {
        return null;
    }
    return {
        memory_limit: fold_memory_or_cpu_limit_field(per_repository, repository_roots, 'memory_limit'),
        cpu_limit: fold_memory_or_cpu_limit_field(per_repository, repository_roots, 'cpu_limit'),
        pids_limit: fold_pids_limit_field(per_repository, repository_roots),
        blkio_weight: fold_blkio_weight_field(per_repository, repository_roots),
    };
}

function fold_memory_or_cpu_limit_field(
    per_repository: readonly (Loaded_Resource_Limits | null)[],
    repository_roots: readonly string[],
    field: 'memory_limit' | 'cpu_limit',
): string | Unlimited | null {
    const contributors = collect_field_contributors<string | Unlimited>(per_repository, repository_roots, field);
    if (contributors.length === 0) {
        return null;
    }
    // If every contributor is the unlimited sentinel, the fold is "unlimited".
    const concrete_contributors = contributors.filter((entry) => entry.value !== UNLIMITED);
    if (concrete_contributors.length === 0) {
        return UNLIMITED;
    }
    // Among concrete values, the smallest wins. `memory_limit` uses size
    // suffixes (`"8g"`, `"512m"`); `cpu_limit` uses decimal strings (`"1.5"`).
    // Both are total-ordered by their semantic numeric value.
    const compare = field === 'memory_limit' ? compare_memory_strings : compare_decimal_strings;
    let smallest = concrete_contributors[0];
    for (let index = 1; index < concrete_contributors.length; index += 1) {
        const candidate = concrete_contributors[index];
        if (compare(candidate.value, smallest.value) < 0) {
            smallest = candidate;
        }
    }
    return smallest.value;
}

function fold_pids_limit_field(
    per_repository: readonly (Loaded_Resource_Limits | null)[],
    repository_roots: readonly string[],
): number | Unlimited | null {
    const contributors = collect_field_contributors<number | Unlimited>(per_repository, repository_roots, 'pids_limit');
    if (contributors.length === 0) {
        return null;
    }
    const concrete = contributors.filter((entry) => entry.value !== UNLIMITED);
    if (concrete.length === 0) {
        return UNLIMITED;
    }
    let smallest = concrete[0].value as number;
    for (let index = 1; index < concrete.length; index += 1) {
        const candidate = concrete[index].value as number;
        if (candidate < smallest) {
            smallest = candidate;
        }
    }
    return smallest;
}

function fold_blkio_weight_field(
    per_repository: readonly (Loaded_Resource_Limits | null)[],
    repository_roots: readonly string[],
): number | null {
    // `blkio_weight` has no `"unlimited"` form; the lattice is just numeric min.
    const contributors = collect_field_contributors<number>(per_repository, repository_roots, 'blkio_weight');
    if (contributors.length === 0) {
        return null;
    }
    let smallest = contributors[0].value;
    for (let index = 1; index < contributors.length; index += 1) {
        if (contributors[index].value < smallest) {
            smallest = contributors[index].value;
        }
    }
    return smallest;
}

interface Field_Contributor<T> {
    repository_root: string;
    value: T;
}

function collect_field_contributors<T>(
    per_repository: readonly (Loaded_Resource_Limits | null)[],
    repository_roots: readonly string[],
    field: keyof Loaded_Resource_Limits,
): Field_Contributor<T>[] {
    const contributors: Field_Contributor<T>[] = [];
    for (let index = 0; index < per_repository.length; index += 1) {
        const loaded = per_repository[index];
        if (loaded === null) {
            continue;
        }

        const value = loaded[field];
        if (value === null) {
            continue;
        }

        contributors.push({ repository_root: repository_roots[index], value: value as T });
    }
    return contributors;
}

/**
 * Compare two memory-suffix strings (`"8g"`, `"512m"`, `"1024"`) by their
 * semantic numeric value in bytes. Returns negative when `a < b`, zero when
 * equal, positive when `a > b`. Suffix recognition is `k`/`m`/`g`
 * (case-insensitive), defaulting to bytes. Used by the lattice min-fold.
 */
function compare_memory_strings(a: string, b: string): number {
    return memory_string_to_bytes(a) - memory_string_to_bytes(b);
}

function memory_string_to_bytes(value: string): number {
    const trimmed = value.trim().toLowerCase();
    const suffix = trimmed.slice(-1);
    const multiplier = suffix === 'g' ? 1024 ** 3
        : suffix === 'm' ? 1024 ** 2
        : suffix === 'k' ? 1024
        : 1;
    const numeric_part = suffix === 'g' || suffix === 'm' || suffix === 'k' ? trimmed.slice(0, -1) : trimmed;
    return Number.parseFloat(numeric_part) * multiplier;
}

/** Compare two decimal-string CPU values (`"1.5"`, `"2"`). */
function compare_decimal_strings(a: string, b: string): number {
    return Number.parseFloat(a) - Number.parseFloat(b);
}

/**
 * Load one configuration file. Returns `null` when the file is absent (or
 * absent-equivalent: broken symlink, symlink-to-directory). Returns a
 * `Loaded_Resource_Limits` (which may have all four fields `null`) when the
 * file parses cleanly. Throws on any malformation.
 */
export function load_configuration_file(file_path: string): Loaded_Resource_Limits | null {
    const parsed = load_full_configuration_file(file_path);
    return parsed?.resource_limits ?? null;
}

/**
 * Load one configuration file including resource limits, default_tool, and
 * tool_configuration settings. Returns `null` when the file is absent.
 */
export function load_full_configuration_file(file_path: string): Parsed_Configuration_File | null {
    const yaml_text = read_configuration_yaml_text(file_path);
    if (yaml_text === null) {
        return null;
    }

    return parse_configuration_yaml(yaml_text, file_path);
}

function read_configuration_yaml_text(file_path: string): string | null {
    // Use `statSync` (which follows symlinks naturally) — symlinks to regular
    // files are followed; broken symlinks throw ENOENT and become "absent";
    // symlinks pointing at directories return a directory stat and we skip.
    let stats: fs.Stats;
    try {
        stats = fs.statSync(file_path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return null;
        }
        throw new Error(
            `failed to stat ${file_path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (!stats.isFile()) {
        // Symlink-to-directory or other non-regular-file target — treat as absent.
        return null;
    }

    if (stats.size > CONFIGURATION_FILE_SIZE_CAP_BYTES) {
        throw new Error(
            `configuration file ${file_path} is ${stats.size} bytes, which exceeds the `
            + `${CONFIGURATION_FILE_SIZE_CAP_BYTES}-byte cap; refusing to read`,
        );
    }

    let yaml_text: string;
    try {
        yaml_text = fs.readFileSync(file_path, 'utf-8');
    } catch (error) {
        throw new Error(
            `failed to read configuration file ${file_path}: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return yaml_text;
}

/**
 * Parse one configuration file's YAML text into a `Parsed_Configuration_File`.
 * Aliases are disabled at the parser level (`maxAliasCount: 0`) — the v1
 * schema is flat and aliases would be an unnecessary attack surface
 * (billion-laughs DoS). A file that parses cleanly but omits optional
 * top-level keys is treated as "no settings here, fall through": returns
 * empty resource-limit fields, `default_tool: null`, and `tool_configuration: null`.
 */
function parse_configuration_yaml(
    yaml_text: string,
    file_path: string,
): Parsed_Configuration_File {
    let parsed: unknown;
    try {
        parsed = YAML.parse(yaml_text, { maxAliasCount: 0 });
    } catch (error) {
        throw new Error(
            `${file_path}: YAML parse error: `
            + `${error instanceof Error ? error.message : String(error)}`,
        );
    }

    // Empty file (YAML `null`) is equivalent to "no settings".
    if (parsed === null || parsed === undefined) {
        return empty_parsed_configuration_file();
    }

    if (!is_plain_object(parsed)) {
        throw new Error(
            `${file_path}: top-level value must be a YAML mapping`,
        );
    }

    for (const key of Object.keys(parsed)) {
        if (!ACCEPTED_TOP_LEVEL_KEYS.has(key)) {
            throw new Error(
                `${file_path}: unknown top-level key "${key}" `
                + `(accepted keys: ${[...ACCEPTED_TOP_LEVEL_KEYS].join(', ')})`,
            );
        }
    }

    const root = parsed as Record<string, unknown>;
    let resource_limits = empty_loaded_resource_limits();
    const resource_limits_raw = root.resource_limits;
    if (resource_limits_raw !== undefined) {
        if (!is_plain_object(resource_limits_raw)) {
            throw new Error(
                `${file_path}: "resource_limits" must be a mapping `
                + `(expected keys: ${listed_accepted_keys()})`,
            );
        }

        resource_limits = yaml_resource_limits_to_loaded(
            resource_limits_raw as Record<string, unknown>,
            file_path,
        );
    }

    const default_tool = parse_default_tool(root.default_tool, file_path);
    const tool_configuration = parse_tool_configuration(root.tool_configuration, file_path);

    return { resource_limits, default_tool, tool_configuration };
}

function empty_parsed_configuration_file(): Parsed_Configuration_File {
    return {
        resource_limits: empty_loaded_resource_limits(),
        default_tool: null,
        tool_configuration: null,
    };
}

function parse_default_tool(raw: unknown, file_path: string): string | null {
    if (raw === undefined || raw === null) {
        return null;
    }

    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error(
            `${file_path}: default_tool must be a non-empty string when set`,
        );
    }

    return raw.trim();
}

function parse_tool_configuration(
    raw: unknown,
    file_path: string,
): Record<string, Partial<Loaded_OpenCode_Settings>> | null {
    if (raw === undefined || raw === null) {
        return null;
    }

    if (!is_plain_object(raw)) {
        throw new Error(`${file_path}: tool_configuration must be a mapping`);
    }

    const loaded: Record<string, Partial<Loaded_OpenCode_Settings>> = {};
    for (const [tool_name, tool_raw] of Object.entries(raw)) {
        if (!KNOWN_TOOL_CONFIGURATION_TOOLS.has(tool_name)) {
            throw new Error(
                `${file_path}: unknown tool "${tool_name}" under tool_configuration `
                + `(known tools: ${[...KNOWN_TOOL_CONFIGURATION_TOOLS].join(', ')})`,
            );
        }

        const block_path = `${file_path}: tool_configuration.${tool_name}`;
        if (tool_name === OPENCODE_TOOL_NAME) {
            const parsed = parse_opencode_settings(tool_raw, block_path);
            if (parsed !== null) {
                loaded[tool_name] = parsed;
            }
        }
    }

    return Object.keys(loaded).length > 0 ? loaded : null;
}

function parse_opencode_settings(
    raw: unknown,
    field_path: string,
): Partial<Loaded_OpenCode_Settings> | null {
    if (raw === undefined || raw === null) {
        return null;
    }

    if (!is_plain_object(raw)) {
        throw new Error(`${field_path} must be a mapping`);
    }

    for (const key of Object.keys(raw)) {
        if (!OPENCODE_SETTINGS_KEYS.has(key)) {
            throw new Error(
                `${field_path}: unknown key "${key}" `
                + `(accepted keys: ${[...OPENCODE_SETTINGS_KEYS].join(', ')})`,
            );
        }
    }

    const settings: Partial<Loaded_OpenCode_Settings> = {};

    if (raw.copy_host_configuration !== undefined && raw.copy_host_configuration !== null) {
        settings.copy_host_configuration = parse_boolean(
            raw.copy_host_configuration,
            `${field_path}.copy_host_configuration`,
        );
    }

    if (raw.copy_host_auth !== undefined && raw.copy_host_auth !== null) {
        settings.copy_host_auth = parse_boolean(raw.copy_host_auth, `${field_path}.copy_host_auth`);
    }
    if (raw.proxy_local_models !== undefined && raw.proxy_local_models !== null) {
        settings.proxy_local_models = parse_boolean(
            raw.proxy_local_models,
            `${field_path}.proxy_local_models`,
        );
    }

    if (raw.environment !== undefined && raw.environment !== null) {
        if (!is_plain_object(raw.environment)) {
            throw new Error(`${field_path}.environment must be a mapping`);
        }
        const environment: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw.environment)) {
            if (typeof value !== 'string') {
                throw new Error(
                    `${field_path}.environment.${key} must be a string`,
                );
            }
            environment[key] = value;
        }
        settings.environment = environment;
    }

    return settings;
}

function parse_boolean(raw: unknown, field_label: string): boolean {
    if (typeof raw !== 'boolean') {
        throw new Error(`${field_label} must be a boolean`);
    }

    return raw;
}

/**
 * Convert a parsed `resource_limits` mapping into a `Loaded_Resource_Limits`,
 * enforcing the schema (accepted keys, value types, ranges, unlimited
 * sentinel normalization). All field-by-field assignments go through this
 * one function — see `RESOURCE_LIMIT_FIELD_MAP` for the rationale.
 */
export function yaml_resource_limits_to_loaded(
    raw: Record<string, unknown>,
    file_path: string,
): Loaded_Resource_Limits {
    for (const key of Object.keys(raw)) {
        if (!ACCEPTED_YAML_KEYS.has(key)) {
            throw new Error(
                `${file_path}: unknown key "${key}" under resource_limits `
                + `(accepted keys: ${listed_accepted_keys()})`,
            );
        }
    }

    const loaded = empty_loaded_resource_limits();
    const loaded_as_record = loaded as unknown as Record<string, unknown>;
    for (const { on_disk_key, typescript_key } of RESOURCE_LIMIT_FIELD_MAP) {
        const raw_value = raw[on_disk_key];
        if (raw_value === undefined || raw_value === null) {
            // Field omitted or explicit YAML null — fall through to lower precedence.
            continue;
        }

        // The narrowing is correct by construction — `parse_resource_limit_field`
        // returns the right value variant for each YAML key. TS can't infer
        // that through the lookup, so the assignment goes through an
        // unknown-typed record view to keep the table-driven loop ergonomic
        // without weakening the public types.
        loaded_as_record[typescript_key] = parse_resource_limit_field(on_disk_key, raw_value, file_path);
    }

    return loaded;
}

function empty_loaded_resource_limits(): Loaded_Resource_Limits {
    return {
        memory_limit: null,
        cpu_limit: null,
        pids_limit: null,
        blkio_weight: null,
    };
}

function listed_accepted_keys(): string {
    return RESOURCE_LIMIT_FIELD_MAP.map((entry) => entry.on_disk_key).join(', ');
}

/**
 * Per-field value validation and normalization. Returns the TS-side value
 * variant the field accepts (string for memory, string for cpus, number for
 * pids, number for blkio_weight). `0` for memory/cpus/pids normalizes to
 * the `UNLIMITED` sentinel; `0` for blkio_weight is rejected because the
 * field has no unlimited form.
 */
function parse_resource_limit_field(
    yaml_key: 'memory' | 'cpus' | 'pids' | 'blkio_weight',
    raw_value: unknown,
    file_path: string,
): string | number | Unlimited {
    switch (yaml_key) {
        case 'memory':
            return parse_memory_field(raw_value, file_path);
        case 'cpus':
            return parse_cpus_field(raw_value, file_path);
        case 'pids':
            return parse_pids_field(raw_value, file_path);
        case 'blkio_weight':
            return parse_blkio_weight_field(raw_value, file_path);
    }
}

const MEMORY_VALUE_PATTERN = /^(\d+)([bkmg]?)$/i;

function parse_memory_field(raw_value: unknown, file_path: string): string | Unlimited {
    // Accept the bare integer `0` (YAML number) as "unlimited"; also accept
    // the string "0" so a quoted form works. Anything else must be a string
    // matching the podman memory format.
    if (raw_value === 0) {
        return UNLIMITED;
    }

    if (typeof raw_value === 'number') {
        if (!Number.isFinite(raw_value) || raw_value < 0 || !Number.isInteger(raw_value)) {
            throw new Error(
                `${file_path}: resource_limits.memory: invalid numeric value ${raw_value} `
                + `(expected a non-negative integer; use 0 for unlimited, or a string like "4g")`,
            );
        }

        // A bare positive integer with no suffix is bytes per podman's format.
        return `${raw_value}`;
    }

    if (typeof raw_value !== 'string') {
        throw new Error(
            `${file_path}: resource_limits.memory: expected a string like "4g" or the integer 0 `
            + `(got ${describe_value(raw_value)})`,
        );
    }

    if (raw_value === '0') {
        return UNLIMITED;
    }

    const match = MEMORY_VALUE_PATTERN.exec(raw_value);
    if (match === null) {
        throw new Error(
            `${file_path}: resource_limits.memory: invalid value "${raw_value}" `
            + `(expected an integer optionally suffixed with b/k/m/g; use 0 for unlimited)`,
        );
    }

    const magnitude = Number(match[1]);
    if (magnitude < 0) {
        throw new Error(
            `${file_path}: resource_limits.memory: negative values are not accepted `
            + `(use 0 for unlimited)`,
        );
    }

    // Reject `"0g"`, `"0m"`, `"0k"`, `"0b"` — a user who writes one of these
    // probably means "unlimited", but `--memory 0g` to podman is "0 bytes,"
    // which would then clamp every per-source value to 0. Force the user to
    // disambiguate: the only "unlimited" form is the bare `0`.
    if (magnitude === 0) {
        throw new Error(
            `${file_path}: resource_limits.memory: "${raw_value}" is ambiguous `
            + `(0 bytes vs unlimited); use the bare integer 0 for unlimited, `
            + `or a positive value like "4g" for a finite cap`,
        );
    }

    return `${match[1]}${match[2].toLowerCase()}`;
}

const CPUS_VALUE_PATTERN = /^\d+(\.\d+)?$/;

function parse_cpus_field(raw_value: unknown, file_path: string): string | Unlimited {
    if (raw_value === 0) {
        return UNLIMITED;
    }

    if (typeof raw_value === 'number') {
        if (!Number.isFinite(raw_value) || raw_value < 0) {
            throw new Error(
                `${file_path}: resource_limits.cpus: invalid numeric value ${raw_value} `
                + `(expected a non-negative decimal; use 0 for unlimited)`,
            );
        }

        // Render integers as `N.0` to match podman's preferred form and the
        // runtime-default emission convention.
        return Number.isInteger(raw_value) ? `${raw_value}.0` : `${raw_value}`;
    }

    if (typeof raw_value !== 'string') {
        throw new Error(
            `${file_path}: resource_limits.cpus: expected a decimal string like "2.0" or a number `
            + `(got ${describe_value(raw_value)})`,
        );
    }

    if (raw_value === '0') {
        return UNLIMITED;
    }

    if (!CPUS_VALUE_PATTERN.test(raw_value)) {
        throw new Error(
            `${file_path}: resource_limits.cpus: invalid value "${raw_value}" `
            + `(expected a non-negative decimal; use 0 for unlimited)`,
        );
    }

    const numeric = Number(raw_value);
    if (numeric < 0) {
        throw new Error(
            `${file_path}: resource_limits.cpus: negative values are not accepted `
            + `(use 0 for unlimited)`,
        );
    }

    return raw_value;
}

function parse_pids_field(raw_value: unknown, file_path: string): number | Unlimited {
    // Accept both number-typed and integer-string-typed values, paralleling
    // memory/cpus which already accept either form. `pids: 1024` and
    // `pids: "1024"` produce identical results.
    let numeric: number;
    if (typeof raw_value === 'number') {
        if (!Number.isFinite(raw_value) || !Number.isInteger(raw_value)) {
            throw new Error(
                `${file_path}: resource_limits.pids: expected a non-negative integer `
                + `(got ${describe_value(raw_value)})`,
            );
        }

        numeric = raw_value;
    } else if (typeof raw_value === 'string' && /^-?\d+$/.test(raw_value)) {
        numeric = Number(raw_value);
    } else {
        throw new Error(
            `${file_path}: resource_limits.pids: expected a non-negative integer `
            + `(got ${describe_value(raw_value)})`,
        );
    }

    if (numeric < 0) {
        throw new Error(
            `${file_path}: resource_limits.pids: negative values are not accepted; `
            + `the only "unlimited" sentinel is the bare 0 (got ${numeric})`,
        );
    }

    if (numeric === 0) {
        return UNLIMITED;
    }

    if (numeric > MAX_PIDS) {
        throw new Error(
            `${file_path}: resource_limits.pids: value ${numeric} exceeds the maximum of ${MAX_PIDS}`,
        );
    }

    return numeric;
}

function parse_blkio_weight_field(raw_value: unknown, file_path: string): number {
    if (typeof raw_value !== 'number' || !Number.isFinite(raw_value) || !Number.isInteger(raw_value)) {
        throw new Error(
            `${file_path}: resource_limits.blkio_weight: expected an integer in [10, 1000] `
            + `(got ${describe_value(raw_value)})`,
        );
    }

    if (raw_value < 10 || raw_value > 1000) {
        throw new Error(
            `${file_path}: resource_limits.blkio_weight: value ${raw_value} is outside the `
            + `documented range [10, 1000]`,
        );
    }

    return raw_value;
}

function describe_value(value: unknown): string {
    if (value === null) {
        return 'null';
    }

    if (Array.isArray(value)) {
        return 'a list';
    }

    return (typeof value === 'object')
        ? 'a mapping'
        : `${typeof value} (${JSON.stringify(value)})`;
}
