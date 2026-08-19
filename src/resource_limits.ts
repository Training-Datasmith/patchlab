/**
 * Resource-limit value types, runtime-computed defaults, and the resolver that
 * combines them with the configuration, persisted-manifest, and CLI layers.
 *
 * The resolver applies a five-layer precedence ladder per field, lowest to
 * highest:
 *   1. Runtime-computed defaults
 *   2. User-global configuration (`~/.patchlab/configuration.yaml`)
 *   3. Per-source configuration (`<source>/.patchlab/configuration.yaml`), clamped
 *      against the value resolved through layers 1 and 2 only
 *   4. Persisted manifest values from the prior session (unclamped)
 *   5. CLI flags
 *
 * Per-field merging means a value at a higher layer overrides only that field,
 * leaving the others to fall through to lower precedence sources. See
 * `resolve_resource_limits` for the per-field merge implementation and the
 * clamp helpers below for the per-source clamp / discard / ignore semantics.
 *
 * "Unlimited": users opt out of enforcement by passing `0` to `--memory`,
 * `--cpus`, or `--pids-limit` (or by setting the YAML field to `0`). Internally
 * that becomes the `"unlimited"` sentinel — distinct from `null` (which only
 * `blkio_weight` ever takes, and which means "no source set this anywhere").
 * The corresponding podman flag is OMITTED from the argv (rather than emitted
 * with a zero value) so `podman inspect` doesn't carry a misleading-looking
 * `0` cap.
 */
import * as os from 'node:os';
import { logger } from './logger.js';
import { query_nerdctl_runtime_capacity } from './nerdctl.js';
// Types only — `configuration.ts` imports the `RESOURCE_LIMIT_FIELD_MAP`
// runtime value from this module; making this a type-only import keeps the
// graph one-way at runtime while letting the resolver name the configuration
// layer's input shape in its public signature.
import type { Loaded_Configuration } from './configuration.js';

/** Sentinel for "user opted out of enforcement" (originating from a user `0`). */
export const UNLIMITED = 'unlimited' as const;
export type Unlimited = typeof UNLIMITED;

/**
 * In-memory persisted-manifest layer used by the resolver. Fields use the
 * `_limit` suffix so a bare access (e.g. `manifest.memory_limit`) reads as
 * a constraint-style noun ("memory limit"), not a usage-style noun ("amount
 * of memory currently used"). Matches the naming convention used by
 * `Resolved_Resource_Limits`, `CLI_Limit_Overrides`, `Runtime_Default_Limits`,
 * and the argv-side `Container_Create_Options` fields — see also
 * `Persisted_Resource_Limits_On_Disk` for the bare-keyed shape that lives in
 * the JSON manifest itself.
 *
 *   - memory_limit / cpu_limit / pids_limit: concrete value OR `"unlimited"`.
 *     Never `null` — runtime defaults always supply a concrete value when no
 *     other source sets one, so reaching "unlimited" requires an explicit
 *     user `0`.
 *   - blkio_weight: concrete integer in [10, 1000] OR `null`. The `null` case
 *     is the legitimate "not set anywhere" path (blkio_weight has no runtime
 *     default), and it falls through to lower-precedence sources on resume.
 */
export interface Persisted_Resource_Limits {
    memory_limit: string;
    cpu_limit: string;
    pids_limit: number | Unlimited;
    blkio_weight: number | null;
}

/**
 * On-disk JSON shape stored at `Session_Metadata.resource_limits`. Keys are
 * intentionally bare (`memory`, `cpus`, `pids`) to match the spec's locked
 * manifest schema and the YAML keys that the follow-up
 * `sandbox-resource-limit-configuration` change will introduce. The TS-side
 * `Persisted_Resource_Limits` adds the `_limit` suffix for readability;
 * converters at the boundary (see `persisted_resource_limits_from_on_disk`
 * and `persisted_resource_limits_to_on_disk` below) translate between the
 * two without leaking the bare names into the resolver call sites.
 */
export interface Persisted_Resource_Limits_On_Disk {
    memory: string;
    cpus: string;
    pids: number | Unlimited;
    blkio_weight: number | null;
}

/** CLI-side input. A field is `undefined` when the user did not pass the flag. */
export interface CLI_Limit_Overrides {
    memory_limit?: string;
    cpu_limit?: string;
    pids_limit?: number | Unlimited;
    blkio_weight?: number;
}

/**
 * Output of the resolver. Carries the user's *choice* per field; argv
 * translation (omit-on-unlimited) happens at the `Container_Create_Options`
 * conversion site, not here.
 */
export interface Resolved_Resource_Limits {
    memory_limit: string;
    cpu_limit: string;
    pids_limit: number | Unlimited;
    blkio_weight: number | null;
}

/**
 * Computed at resolve time (not module load) so hardware changes — e.g. moving
 * a VM image between hosts — are reflected without reinstalling patchlab.
 */
export interface Runtime_Default_Limits {
    memory_limit: string;
    cpu_limit: string;
    pids_limit: number;
}

const ONE_GIBIBYTE = 1024 * 1024 * 1024;
const TWO_FIFTY_SIX_MEBIBYTES = 256 * 1024 * 1024;

export function compute_runtime_defaults(): Runtime_Default_Limits {
    const runtime_capacity = query_nerdctl_runtime_capacity();
    const total_bytes = runtime_capacity?.memory_bytes ?? os.totalmem();
    const cpu_count = runtime_capacity?.cpu_count ?? os.cpus().length;
    const seventy_five_percent = Math.floor(total_bytes * 0.75);
    const rounded_to_256mib = Math.floor(seventy_five_percent / TWO_FIFTY_SIX_MEBIBYTES) * TWO_FIFTY_SIX_MEBIBYTES;
    const memory_bytes = Math.max(ONE_GIBIBYTE, rounded_to_256mib);

    const cpu_count_minus_one = Math.max(1, cpu_count - 1);

    return {
        memory_limit: format_memory_for_podman(memory_bytes),
        cpu_limit: `${cpu_count_minus_one}.0`,
        pids_limit: 1024,
    };
}

/**
 * Format a byte count as a podman-compatible memory string. Emits the largest
 * unit that produces an integer value (so 1 GiB → `'1g'`, 1.25 GiB → `'1280m'`)
 * so the argv stays human-readable and `podman inspect` shows clean values.
 */
function format_memory_for_podman(bytes: number): string {
    if (bytes % ONE_GIBIBYTE === 0) {
        return `${bytes / ONE_GIBIBYTE}g`;
    }

    const mebibyte = 1024 * 1024;
    if (bytes % mebibyte === 0) {
        return `${bytes / mebibyte}m`;
    }

    const kibibyte = 1024;
    return (bytes % kibibyte === 0) ? `${bytes / kibibyte}k` : `${bytes}b`;
}

/**
 * Apply the five-layer precedence ladder per field (lowest to highest):
 *   1. Runtime-computed defaults
 *   2. User-global `~/.patchlab/configuration.yaml`        (loaded.user_global)
 *   3. Per-source `<source>/.patchlab/configuration.yaml`, clamped against
 *      the value resolved through layers 1 and 2 only      (loaded.per_source)
 *   4. Persisted manifest values from prior session         (manifest_layer)
 *   5. CLI flags                                            (cli_overrides)
 *
 * Per-field merge: a higher-precedence value overrides ONLY that field. The
 * persisted-manifest layer is intentionally NOT clamped against the user-global
 * upper bound — a value the user explicitly chose at create time should not be
 * silently undone by a per-source value the resolver finds on resume.
 *
 * Clamp / discard / ignore events for the per-source layer are routed through
 * `logger().verbose(...)` — see the per-field merge helpers below for the
 * message formats. The clamp itself never errors and never aborts sandbox
 * creation; it just records what happened.
 *
 * `loaded`, `manifest_layer`, and `cli_overrides` all admit "nothing here":
 * `loaded` accepts `{ user_global: null, per_source: null }` (no config files);
 * `manifest_layer` is `null` on first create or for metadata predating the
 * feature; `cli_overrides` is `{}` when the user passed no flags.
 */
export function resolve_resource_limits(
    loaded: Loaded_Configuration,
    manifest_layer: Persisted_Resource_Limits | null,
    cli_overrides: CLI_Limit_Overrides,
): Resolved_Resource_Limits {
    const defaults = compute_runtime_defaults();
    const user_global = loaded.user_global;
    const per_source = loaded.per_source;

    const memory_limit = resolve_concrete_or_unlimited_field(
        'memory',
        defaults.memory_limit,
        user_global?.memory_limit,
        per_source?.memory_limit,
        manifest_layer?.memory_limit,
        cli_overrides.memory_limit,
        compare_memory_values,
    );
    const cpu_limit = resolve_concrete_or_unlimited_field(
        'cpus',
        defaults.cpu_limit,
        user_global?.cpu_limit,
        per_source?.cpu_limit,
        manifest_layer?.cpu_limit,
        cli_overrides.cpu_limit,
        compare_cpu_values,
    );
    const pids_limit = resolve_concrete_or_unlimited_field(
        'pids',
        defaults.pids_limit,
        user_global?.pids_limit,
        per_source?.pids_limit,
        manifest_layer?.pids_limit,
        cli_overrides.pids_limit,
        compare_number_values,
    );
    const blkio_weight = resolve_blkio_weight(
        user_global?.blkio_weight ?? null,
        per_source?.blkio_weight ?? null,
        manifest_layer?.blkio_weight ?? null,
        cli_overrides.blkio_weight,
    );

    return { memory_limit, cpu_limit, pids_limit, blkio_weight };
}

/**
 * Apply the five-layer ladder for one of the three "concrete-or-unlimited"
 * fields (memory, cpus, pids). The structural shape is identical across the
 * three; only the value-comparison function differs (memory parses size
 * suffixes; cpus parses decimal; pids is a plain number).
 *
 * `compare(a, b)` returns negative when `a < b`, zero when equal, positive
 * when `a > b`. The clamp emits `min(per_source_value, upper_bound)`.
 */
function resolve_concrete_or_unlimited_field<T extends string | number>(
    field_name: 'memory' | 'cpus' | 'pids',
    runtime_default: T,
    user_global_value: T | Unlimited | null | undefined,
    per_source_value: T | Unlimited | null | undefined,
    manifest_value: T | Unlimited | undefined,
    cli_value: T | Unlimited | undefined,
    compare: (a: T, b: T) => number,
): T | Unlimited {
    // Layers 1 + 2: runtime default then user-global override.
    let lower_resolution: T | Unlimited = runtime_default;
    if (user_global_value !== null && user_global_value !== undefined) {
        lower_resolution = user_global_value;
    }

    // Layer 3 (clamped): per-source. Three cases — omitted (no-op), explicit
    // unlimited (no-op + verbose), or a concrete value (clamp against the
    // lower-layer resolution + verbose if clamped).
    let after_per_source: T | Unlimited = lower_resolution;
    if (per_source_value !== null && per_source_value !== undefined) {
        after_per_source = apply_per_source_clamp(
            field_name,
            per_source_value,
            lower_resolution,
            compare,
        );
    }

    // Layer 4: persisted manifest — NOT clamped against any earlier layer.
    let after_manifest: T | Unlimited = after_per_source;
    if (manifest_value !== undefined) {
        after_manifest = manifest_value;
    }

    // Layer 5: CLI — always wins when present.
    if (cli_value !== undefined) {
        return cli_value;
    }
    return after_manifest;
}

function apply_per_source_clamp<T extends string | number>(
    field_name: 'memory' | 'cpus' | 'pids',
    per_source_value: T | Unlimited,
    upper_bound: T | Unlimited,
    compare: (a: T, b: T) => number,
): T | Unlimited {
    if (per_source_value === UNLIMITED) {
        // Per-source `unlimited` is treated as "no per-source preference" —
        // it does NOT widen the upper bound. Record the discarded preference.
        // When the upper bound is itself unlimited, the "no widening above
        // unlimited" wording is a tautology; specialize the message to
        // describe the actual situation.
        const reason = upper_bound === UNLIMITED
            ? 'lower-precedence layers already resolve to unlimited'
            : `no widening above ${upper_bound}`;
        logger().verbose(
            `configuration: discarded per-source ${field_name}: 0 (${reason})`,
        );
        return upper_bound;
    }

    if (upper_bound === UNLIMITED) {
        // Per-source tightens an unlimited ceiling to a concrete value — the
        // intended use of per-source against an unbounded layer. No clamp event.
        return per_source_value;
    }

    if (compare(per_source_value, upper_bound) <= 0) {
        // Per-source is within the bound — apply it as-is. No clamp event.
        return per_source_value;
    }

    // Per-source exceeds the bound — clamp to the bound and record the event.
    logger().verbose(
        `configuration: clamped per-source ${field_name} (${per_source_value}) `
        + `to upper bound (${upper_bound})`,
    );
    return upper_bound;
}

/**
 * `blkio_weight` is structurally different from the other three fields: it
 * has no runtime default and no `"unlimited"` form, and the spec mandates
 * that per-source values are IGNORED entirely (the field is a relative
 * weight, not a cap, so "tightening" isn't meaningful).
 */
function resolve_blkio_weight(
    user_global_value: number | null,
    per_source_value: number | null,
    manifest_value: number | null,
    cli_value: number | undefined,
): number | null {
    if (per_source_value !== null) {
        logger().verbose(
            `configuration: ignored per-source blkio_weight (${per_source_value}) `
            + `(relative weight is not subject to clamping)`,
        );
    }

    if (cli_value !== undefined) {
        return cli_value;
    }

    if (manifest_value !== null) {
        return manifest_value;
    }

    if (user_global_value !== null) {
        return user_global_value;
    }

    return null;
}

/**
 * Memory value comparator. Handles podman's mixed format (`4g`, `512m`, etc.)
 * by parsing to a byte count. Inputs are assumed to match the
 * `MEMORY_VALUE_PATTERN` regex (validated upstream by the loader and CLI
 * parser); an unparseable value crashes with a clear message rather than
 * silently mis-ordering.
 */
function compare_memory_values(a: string, b: string): number {
    return memory_string_to_bytes(a) - memory_string_to_bytes(b);
}

function memory_string_to_bytes(value: string): number {
    const match = /^(\d+)([bkmg]?)$/i.exec(value);
    if (match === null) {
        throw new Error(
            `compare_memory_values: unparseable memory value "${value}" — `
            + `loader/CLI parser should have caught this upstream`,
        );
    }
    const magnitude = Number(match[1]);
    switch (match[2].toLowerCase()) {
        case 'g': return magnitude * 1024 * 1024 * 1024;
        case 'm': return magnitude * 1024 * 1024;
        case 'k': return magnitude * 1024;
        case 'b': case '': return magnitude;
    }
    return magnitude;
}

function compare_cpu_values(a: string, b: string): number {
    return Number(a) - Number(b);
}

function compare_number_values(a: number, b: number): number {
    return a - b;
}

/**
 * Argv-side translation. `"unlimited"` and `null` both map to `undefined`
 * (the corresponding podman flag is omitted from the argv); concrete values
 * pass through unchanged. The two alphabets are intentionally different —
 * the manifest preserves the user's *intent* (so resume can honor an
 * unlimited choice), while the argv preserves the wire format.
 */
export interface Resolved_Resource_Limits_Argv {
    memory_limit?: string;
    cpu_limit?: string;
    pids_limit?: number;
    blkio_weight?: number;
}

export function resolved_limits_to_create_options(
    resolved: Resolved_Resource_Limits,
): Resolved_Resource_Limits_Argv {
    return {
        memory_limit: resolved.memory_limit === UNLIMITED ? undefined : resolved.memory_limit,
        cpu_limit: resolved.cpu_limit === UNLIMITED ? undefined : resolved.cpu_limit,
        pids_limit: resolved.pids_limit === UNLIMITED ? undefined : resolved.pids_limit,
        blkio_weight: resolved.blkio_weight === 0 ? undefined : (resolved.blkio_weight ?? undefined),
    };
}

/**
 * Persisted-side translation (in-memory shape). The resolver's output already
 * matches the in-memory persisted shape (same field names, same value
 * variants), so this is effectively an identity but kept as a named helper
 * to make call sites read intentionally and to localize any future divergence.
 */
export function resolved_limits_to_persisted(
    resolved: Resolved_Resource_Limits,
): Persisted_Resource_Limits {
    return {
        memory_limit: resolved.memory_limit,
        cpu_limit: resolved.cpu_limit,
        pids_limit: resolved.pids_limit,
        blkio_weight: resolved.blkio_weight,
    };
}

/**
 * Single source of truth for the YAML/on-disk-key ↔ TS-field mapping. Every
 * converter between bare-keyed and `_limit`-suffixed representations (the
 * two below, the YAML loader in `src/configuration.ts`, any future writer)
 * MUST read this table rather than hard-coding the pairing inline, so a field
 * rename only needs editing one place. The order matches the canonical schema
 * order (`memory`, `cpus`, `pids`, `blkio_weight`) so loop-derived output —
 * including unknown-key error messages that enumerate accepted fields —
 * reads in the documented order.
 */
export const RESOURCE_LIMIT_FIELD_MAP: readonly {
    on_disk_key: keyof Persisted_Resource_Limits_On_Disk;
    typescript_key: keyof Persisted_Resource_Limits;
}[] = [
    { on_disk_key: 'memory', typescript_key: 'memory_limit' },
    { on_disk_key: 'cpus', typescript_key: 'cpu_limit' },
    { on_disk_key: 'pids', typescript_key: 'pids_limit' },
    { on_disk_key: 'blkio_weight', typescript_key: 'blkio_weight' },
];

/**
 * Boundary converter: bare on-disk keys → TS-side `_limit`-suffixed names.
 * Called by `read_session_metadata` consumers when feeding the persisted
 * manifest layer into the resolver. Keeps the bare-key on-disk shape (locked
 * by the spec and shared with the YAML keys in
 * `src/configuration.ts`) isolated from the in-memory readability convention.
 *
 * The body iterates `RESOURCE_LIMIT_FIELD_MAP` rather than hard-coding the
 * pairing — see that constant's docstring for the rationale.
 */
export function persisted_resource_limits_from_on_disk(
    on_disk: Persisted_Resource_Limits_On_Disk,
): Persisted_Resource_Limits {
    const output = {} as Record<keyof Persisted_Resource_Limits, unknown>;
    for (const { on_disk_key, typescript_key } of RESOURCE_LIMIT_FIELD_MAP) {
        output[typescript_key] = on_disk[on_disk_key];
    }
    return output as Persisted_Resource_Limits;
}

/**
 * Boundary converter: TS-side `_limit`-suffixed names → bare on-disk keys.
 * Called by `write_session_metadata` consumers right before the in-memory
 * persisted shape is serialized into `Session_Metadata.resource_limits`.
 *
 * Reads the same `RESOURCE_LIMIT_FIELD_MAP` source-of-truth as the inverse
 * direction so the two converters cannot drift apart.
 */
export function persisted_resource_limits_to_on_disk(
    in_memory: Persisted_Resource_Limits,
): Persisted_Resource_Limits_On_Disk {
    const output = {} as Record<keyof Persisted_Resource_Limits_On_Disk, unknown>;
    for (const { on_disk_key, typescript_key } of RESOURCE_LIMIT_FIELD_MAP) {
        output[on_disk_key] = in_memory[typescript_key];
    }
    return output as Persisted_Resource_Limits_On_Disk;
}

/**
 * Literal flag tokens recognized by `argv_contains_resource_flag_negative`.
 * Anything not in this list is ignored by the pre-parse guard — flags from
 * other parts of the CLI must do their own validation.
 */
export const RESOURCE_LIMIT_FLAGS: readonly string[] = [
    '--memory',
    '--cpus',
    '--pids-limit',
    '--blkio-weight',
];

/**
 * Pre-parse guard for negative resource-limit flag values. Scans `argv` for
 * a resource-limit flag followed by a token matching `^-\d` (a negative
 * integer or decimal) and returns the offending flag name when detected, or
 * `null` otherwise.
 *
 * Why this exists: Commander parses `--pids-limit -1` (with a space) by
 * treating `-1` as a separate token that looks like a flag, producing a
 * "missing argument" or "unknown option" error that does not clearly name
 * the resource flag. The CLI runs this guard before Commander touches argv
 * so the user sees `error: --pids-limit: negative values are not accepted`
 * regardless of which side parses the value.
 *
 * Equals-form (`--flag=-N`) is handled by Commander's value parser instead;
 * the guard only catches the space-separated form. The scan stops at the
 * first `--` token (end-of-options separator) — flags after `--` are
 * positional arguments, not options.
 */
export function argv_contains_resource_flag_negative(
    argv: readonly string[],
): { flag: string } | null {
    const negative_number_pattern = /^-\d/;
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--') {
            return null;
        }

        if (!RESOURCE_LIMIT_FLAGS.includes(token)) {
            continue;
        }

        const next_token = argv[i + 1];
        if (next_token !== undefined && negative_number_pattern.test(next_token)) {
            return { flag: token };
        }
    }

    return null;
}

const MEMORY_VALUE_PATTERN = /^(\d+)([bkmg]?)$/i;

/**
 * Parse `--memory <value>` per podman's format (integer optionally suffixed
 * with `b`, `k`, `m`, `g`; case-insensitive). `0` is the "explicitly
 * unlimited" sentinel. Throws on negative/non-numeric/out-of-format input —
 * Commander surfaces the error as `error: option '--memory <value>'` with
 * the thrown message. The space-separated negative case is caught by the
 * pre-parse guard before this parser runs.
 */
export function parse_memory_value(value: string): string {
    if (value === '0') {
        return UNLIMITED;
    }

    const match = MEMORY_VALUE_PATTERN.exec(value);
    if (match === null) {
        throw new Error(
            `--memory: invalid value "${value}" (expected an integer optionally suffixed `
            + `with b/k/m/g; use 0 for unlimited)`,
        );
    }

    const magnitude = Number(match[1]);
    if (magnitude === 0) {
        return UNLIMITED;
    }

    // Normalize the suffix to lowercase so downstream argv is consistent
    // (`--memory 4G` and `--memory 4g` produce the same podman invocation).
    return `${match[1]}${match[2].toLowerCase()}`;
}

const CPUS_VALUE_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Parse `--cpus <value>` per podman's format (positive decimal). `0` means
 * unlimited. Reject negatives and non-numeric tokens.
 */
export function parse_cpus_value(value: string): string {
    if (value === '0') {
        return UNLIMITED;
    }

    if (!CPUS_VALUE_PATTERN.test(value)) {
        throw new Error(
            `--cpus: invalid value "${value}" (expected a non-negative decimal; use 0 for unlimited)`,
        );
    }

    const numeric = Number(value);
    if (numeric === 0) {
        return UNLIMITED;
    }

    return value;
}

const MAX_PIDS = 2 ** 31 - 1;

/**
 * Parse `--pids-limit <value>` (non-negative integer). `0` means unlimited.
 * The 2^31-1 upper bound rejects obvious typos (no kernel supports that
 * many tasks per cgroup anyway).
 */
export function parse_pids_value(value: string): number | Unlimited {
    if (value === '0') {
        return UNLIMITED;
    }

    if (!/^\d+$/.test(value)) {
        throw new Error(
            `--pids-limit: invalid value "${value}" (expected a non-negative integer; use 0 for unlimited)`,
        );
    }

    const numeric = Number(value);
    if (numeric === 0) {
        return UNLIMITED;
    }

    if (numeric > MAX_PIDS) {
        throw new Error(`--pids-limit: value ${numeric} exceeds the maximum of ${MAX_PIDS}`);
    }

    return numeric;
}

/**
 * Parse `--blkio-weight <value>` (integer in [10, 1000], or 0 to clear).
 * 0 is a sentinel meaning "remove the weight limit on resume"; it is never
 * passed to the container runtime. Out-of-range values fail with a message
 * naming the flag, the valid range, and the clear sentinel.
 */
export function parse_blkio_weight_value(value: string): number {
    if (!/^-?\d+$/.test(value)) {
        throw new Error(
            `--blkio-weight: invalid value "${value}" (expected an integer in [10, 1000], or 0 to clear)`,
        );
    }

    const numeric = Number(value);
    if (numeric === 0) {
        return 0;
    }

    if (numeric < 10 || numeric > 1000) {
        throw new Error(`--blkio-weight: value ${numeric} is outside the documented range [10, 1000] (use 0 to clear)`);
    }

    return numeric;
}