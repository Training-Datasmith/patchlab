import * as path from 'node:path';
import {
    assert_parsed_object_root,
    parse_file_as_json,
    require_string_field,
    validate_string_or_null_map,
    validate_optional_string_field,
    validate_optional_string_array_field,
    validate_optional_string_record_field,
} from './json_validators.js';
import { atomic_write_file } from './safe_filesystem.js';
import { paths_equal_for_host } from './path_containment.js';
import type { Npm_Package_Requirement } from './detect/index.js';

/** The current archive format version. Readers fail on unrecognized values. */
export const CURRENT_FORMAT_VERSION = 0;

/**
 * Per-entry shape for an entry inside `Sandbox_Manifest.sources`. Every field
 * is required; no `null` or `undefined`.
 *
 * - `host_path`: absolute resolved host path to the source directory.
 *   `host_path === path.join(repository_root, source_prefix)` SHALL hold;
 *   readers validate this invariant at read time.
 * - `repository_root`: absolute path to the host git repository containing
 *   `host_path` (output of `git rev-parse --show-toplevel`).
 * - `source_prefix`: relative path from `repository_root` to `host_path`,
 *   forward slashes, no trailing slash. Empty string indicates the source IS
 *   the repository root; `source_prefix` is NEVER `"."`.
 * - `mount_name`: container-side mount directory under `${HOME}/workspace/`.
 *   For single-repository patchlabs `mount_name` defaults to `source_prefix`
 *   when no `--mount` flag is supplied; an explicit `--mount` MAY override.
 *   For multi-repository patchlabs every source MUST carry an explicit
 *   `mount_name` (no default), because `source_prefix` is per-repository and the
 *   same prefix could appear in two repositories. Readers SHALL NOT assume
 *   `mount_name === source_prefix`.
 */
export interface Source_Specification {
    host_path: string;
    repository_root: string;
    source_prefix: string;
    mount_name: string;
}

/**
 * On-disk metadata for a patchlab.
 *
 * Patchlab vs sandbox vs session terminology:
 * - A patchlab is the persistent identity (this manifest, the host repository branch, and any associated containers).
 * - A sandbox is the ephemeral container where code runs.
 * - A session is one injection/extraction pair within a patchlab.
 *
 * Per-repository SHA fields are map-shaped — `baseline_commit_shas` and
 * `branch_creation_point_shas` are keyed on the manifest's distinct
 * `repository_root` strings (one entry per repository). For single-repository
 * patchlabs each map has one entry; for multi-repository patchlabs each map
 * has N entries, one per distinct `repository_root` in `sources`. Use
 * `manifest_repositories(manifest)` to enumerate the keys; the legacy
 * single-key fields `baseline_commit_sha` / `branch_creation_point_sha` are
 * read-tolerated and synthesized into single-entry maps (keyed on
 * `manifest_primary_source(manifest).repository_root`) on read. Writers
 * emit only the map fields.
 *
 * Most fields are populated at create time. Newer fields default to safe values for
 * legacy manifests (those written before the field existed) so older patchlabs remain readable.
 */
export interface Sandbox_Manifest {
    id: string;
    /** Archive format version. Missing in legacy manifests; treated as 0 on read. */
    format_version: number;
    /**
     * Per-source entries. At least one entry. Entries MAY span multiple
     * distinct `repository_root` values (multi-repository patchlab) or all
     * share one `repository_root` (single-repository patchlab, including
     * the single-source case). Source-set validation rules — mount-name
     * uniqueness, multi-repository mount-name explicitness, within-repository
     * source-prefix uniqueness, within-repository nested-prefix overlap —
     * are enforced at create time before the sandbox is built.
     */
    sources: Source_Specification[];
    /**
     * Per-repository SHA of the dirty-working-tree baseline commit on the patchlab branch.
     * Keys are the manifest's distinct `repository_root` strings; values are the
     * baseline commit SHA for that repository, or `null` if the working tree was clean
     * at create time for that repository. Single-repository patchlabs have one entry;
     * multi-repository patchlabs have one entry per distinct repository.
     */
    baseline_commit_shas: Record<string, string | null>;
    /**
     * Per-repository SHA of the host repository's HEAD at the moment the patchlab
     * branch was cut. Used as the start of the cumulative-diff range when no
     * baseline commit exists. Keys are the manifest's distinct `repository_root`
     * strings. A `null` entry indicates a legacy manifest predating the field;
     * readers fall back to a merge-base heuristic in that case. Single-repository
     * patchlabs have one entry; multi-repository patchlabs have one entry per
     * distinct repository.
     */
    branch_creation_point_shas: Record<string, string | null>;
    created_at: string;
    container_name: string;
    container_image: string;
    effective_image?: string;
    tool?: string;
    include_globs?: string[];
    exclude_globs?: string[];
    volume_mounts?: string[];
    environment_variables?: Record<string, string>;
    npm_packages?: Npm_Package_Requirement[];
}

/**
 * Return the primary source entry (the positional CLI argument at create time).
 * Throws if `manifest.sources` is empty — that case should already have been
 * rejected at read time, but the helper defends in depth.
 */
export function manifest_primary_source(manifest: Sandbox_Manifest): Source_Specification {
    if (manifest.sources.length === 0) {
        throw new Error('Sandbox_Manifest has no sources — manifest must declare at least one source.');
    }

    return manifest.sources[0];
}

/** Return the tool recorded on a sandbox manifest, or throw if it is absent. */
export function resolve_manifest_tool(manifest: Pick<Sandbox_Manifest, 'tool'>): string {
    if (manifest.tool === undefined || manifest.tool === '') {
        throw new Error('Sandbox manifest is missing required field "tool".');
    }

    return manifest.tool;
}

/**
 * Return the deduplicated `repository_root` values across `manifest.sources`
 * in first-appearance order. Each call returns a fresh array the caller owns;
 * mutating it does not affect subsequent calls. Deduplication is byte-for-byte
 * string equality on `repository_root` (no realpath, no case folding, no
 * trailing-slash normalization).
 *
 * Single-repository patchlabs return a one-element array; multi-repository
 * patchlabs return one element per distinct `repository_root` in
 * `manifest.sources`, ordered by first appearance.
 */
export function manifest_repositories(manifest: Sandbox_Manifest): string[] {
    return distinct_repositories_from_sources(manifest.sources);
}

/**
 * Compute the deduplicated, first-appearance-ordered list of `repository_root`
 * values from a resolved `Source_Specification[]`. Same semantics as
 * `manifest_repositories(manifest)` but operates pre-manifest — useful for
 * `create_sandbox` callers that need the repository set BEFORE the manifest has
 * been built (e.g., for per-repository trust registration and configuration
 * composition).
 */
export function distinct_repositories_from_sources(sources: readonly Source_Specification[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const entry of sources) {
        if (seen.has(entry.repository_root)) {
            continue;
        }

        seen.add(entry.repository_root);
        ordered.push(entry.repository_root);
    }

    return ordered;
}

const MANIFEST_FILENAME = 'manifest.json';

function manifest_path(sandbox_directory: string): string {
    return path.join(sandbox_directory, MANIFEST_FILENAME);
}

export interface Create_Manifest_Options {
    include?: string[];
    exclude?: string[];
    /**
     * Single-repository baseline SHA passed by the caller. Mapped to a single-entry
     * `baseline_commit_shas` keyed on the resolved sources' primary repository. The
     * map-input form (`baseline_commit_shas`) takes precedence when both are
     * supplied, and is the multi-repository path used by the two-phase create flow
     * in `multi-source-lifecycle`.
     */
    baseline_commit_sha?: string | null;
    /**
     * Single-repository branch-creation-point SHA passed by the caller. Mapped to a
     * single-entry `branch_creation_point_shas` keyed on the resolved sources'
     * primary repository. The map-input form takes precedence when both are supplied.
     */
    branch_creation_point_sha?: string | null;
    /**
     * Per-repository baseline-commit map. Keys are the manifest's distinct
     * `repository_root` values (typically the output of
     * `manifest_repositories` applied to the resolved sources). When supplied,
     * this map is used as-is and the singular `baseline_commit_sha` field is
     * ignored. When omitted, the function synthesizes a single-entry map from
     * the singular field (back-compat for single-repository callers).
     */
    baseline_commit_shas?: Record<string, string | null>;
    /**
     * Per-repository branch-creation-point map. Mirrors `baseline_commit_shas`'s
     * keyset and precedence rules.
     */
    branch_creation_point_shas?: Record<string, string | null>;
}

export function create_manifest(
    id: string,
    sources: Source_Specification[],
    container_name: string,
    container_image: string,
    options?: Create_Manifest_Options
): Sandbox_Manifest {
    if (sources.length === 0) {
        throw new Error('create_manifest: sources array must be non-empty.');
    }
    for (const entry of sources) {
        assert_writer_source_specification_invariants(entry);
    }

    // Derive the repository keyset from the resolved sources rather than calling
    // `manifest_repositories(manifest)` on a not-yet-constructed manifest.
    // Same deduplication-in-first-appearance-order semantics.
    const repositories = distinct_repositories_from_sources(sources);
    const baseline_commit_shas = resolve_sha_map_input(
        options?.baseline_commit_shas,
        options?.baseline_commit_sha,
        repositories,
    );
    const branch_creation_point_shas = resolve_sha_map_input(
        options?.branch_creation_point_shas,
        options?.branch_creation_point_sha,
        repositories,
    );

    const manifest: Sandbox_Manifest = {
        id,
        format_version: CURRENT_FORMAT_VERSION,
        sources,
        baseline_commit_shas,
        branch_creation_point_shas,
        created_at: new Date().toISOString(),
        container_name,
        container_image,
    };
    if (options?.include) {
        manifest.include_globs = options.include;
    }
    if (options?.exclude) {
        manifest.exclude_globs = options.exclude;
    }

    return manifest;
}

/**
 * Resolve the per-repository SHA map for `create_manifest`'s options.
 *
 * Precedence: explicit map > singular legacy field > all-null default.
 *
 * - When the caller supplied a `map_input`, it is used as-is. Missing keys for
 *   any repository in `repositories` default to `null` so the resulting map's
 *   keyset exactly equals `repositories`.
 * - When the caller supplied only the singular `legacy_input`, the same value
 *   is broadcast to every repository (the single-repository back-compat path).
 * - When neither is supplied, every repository gets `null`.
 */
function resolve_sha_map_input(
    map_input: Record<string, string | null> | undefined,
    legacy_input: string | null | undefined,
    repositories: string[],
): Record<string, string | null> {
    if (map_input !== undefined) {
        const result: Record<string, string | null> = {};
        for (const repository of repositories) {
            result[repository] = Object.hasOwn(map_input, repository)
                ? map_input[repository] : null;
        }
        return result;
    }

    const default_value = legacy_input ?? null;
    return repositories.reduce<Record<string, string | null>>((accumulator, repository) => {
        accumulator[repository] = default_value;
        return accumulator;
    }, {});
}

/**
 * Writer-side invariant guard: every emitted `Source_Specification` SHALL
 * satisfy `host_path === path.join(repository_root, source_prefix)` (modulo
 * host-platform case sensitivity and separator normalization). The
 * `mount_name === source_prefix` equality from subpaths and
 * `multi-source-schema` is LIFTED — multi-source-lifecycle allows explicit
 * `--mount` overrides that differ from `source_prefix`. Writers SHALL preserve
 * whatever `mount_name` value the create-time resolver produced.
 */
function assert_writer_source_specification_invariants(entry: Source_Specification): void {
    // paths_equal_for_host normalizes separators / trailing slash and applies
    // host case-folding itself, so the raw paths can be compared directly.
    const joined = path.join(entry.repository_root, entry.source_prefix);
    if (!paths_equal_for_host(joined, entry.host_path)) {
        throw new Error(
            `Source_Specification writer invariant violated: host_path (${entry.host_path}) `
            + `must equal path.join(repository_root, source_prefix) (${path.join(entry.repository_root, entry.source_prefix)}).`
        );
    }
}

/**
 * Normalize a path string for STORAGE (the recomputed `host_path` synthesized
 * from a legacy manifest): replace backslashes with forward slashes and strip a
 * trailing slash. The result is NOT case-folded — case is part of the stored
 * value. Containment/equality comparisons go through `paths_equal_for_host`
 * (path_containment.ts), which folds case itself, so this is no longer used on
 * the comparison path.
 */
function normalize_for_storage(value: string): string {
    const forward = value.replaceAll('\\', '/');

    const result = (forward.length > 1 && forward.endsWith('/'))
        ? forward.replace(/\/+$/, '')
        : forward;
    return result || '/';
}

interface Legacy_Manifest_Fields {
    source_path?: string;
    repository_root?: string | null;
    source_prefix?: string;
    /** Legacy single-key SHA fields read-tolerated and synthesized into the map shape. */
    baseline_commit_sha?: string | null;
    branch_creation_point_sha?: string | null;
}

/**
 * Read a manifest from disk, applying legacy defaults for fields absent in older manifests.
 * Throws if `format_version` is set to a value this version of patchlab does not recognize.
 */
export function read_manifest(sandbox_directory: string): Sandbox_Manifest {
    const file_path = manifest_path(sandbox_directory);
    const parsed: unknown = parse_file_as_json(file_path);
    const raw = assert_parsed_object_root(parsed, file_path);
    const raw_legacy = raw as Partial<Sandbox_Manifest> & Legacy_Manifest_Fields;

    const format_version = typeof raw.format_version === 'number' ? raw.format_version : 0;
    if (format_version !== CURRENT_FORMAT_VERSION) {
        throw new Error(
            `Unrecognized patchlab archive format_version: ${format_version}. ` +
            `This build understands version ${CURRENT_FORMAT_VERSION}.`
        );
    }

    const sources = resolve_sources_from_raw(raw_legacy, file_path);
    const primary_repository = sources[0].repository_root;
    const baseline_commit_shas = synthesize_sha_map(
        validate_string_or_null_map(raw.baseline_commit_shas, 'baseline_commit_shas', file_path),
        raw_legacy.baseline_commit_sha,
        primary_repository,
    );
    const branch_creation_point_shas = synthesize_sha_map(
        validate_string_or_null_map(raw.branch_creation_point_shas, 'branch_creation_point_shas', file_path),
        raw_legacy.branch_creation_point_sha,
        primary_repository,
    );

    return {
        id: require_string_field(raw, 'id', file_path),
        format_version,
        sources,
        baseline_commit_shas,
        branch_creation_point_shas,
        created_at: require_string_field(raw, 'created_at', file_path),
        container_name: require_string_field(raw, 'container_name', file_path),
        container_image: require_string_field(raw, 'container_image', file_path),
        effective_image: validate_optional_string_field(raw, 'effective_image', file_path),
        tool: validate_optional_string_field(raw, 'tool', file_path),
        include_globs: validate_optional_string_array_field(raw, 'include_globs', file_path),
        exclude_globs: validate_optional_string_array_field(raw, 'exclude_globs', file_path),
        volume_mounts: validate_optional_string_array_field(raw, 'volume_mounts', file_path),
        environment_variables: validate_optional_string_record_field(raw, 'environment_variables', file_path),
        npm_packages: Array.isArray(raw['npm_packages']) ? raw['npm_packages'] as Npm_Package_Requirement[] : undefined,
    };
}

/**
 * Best-effort extraction of repository roots from a manifest file that may be
 * too corrupt for `read_manifest`. Used by destroy when the archive metadata
 * cannot be validated but branch cleanup may still be possible with `--force`.
 */
export function try_read_manifest_repository_roots(sandbox_directory: string): string[] {
    const file_path = manifest_path(sandbox_directory);
    let parsed: unknown;
    try {
        parsed = parse_file_as_json(file_path);
    } catch (_unparseable_json) {
        return [];
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return [];
    }

    const raw = parsed as Partial<Sandbox_Manifest> & Legacy_Manifest_Fields;
    const roots = new Set<string>();

    if (Array.isArray(raw.sources)) {
        for (const entry of raw.sources) {
            if (typeof entry !== 'object' || entry === null) {
                continue;
            }
            const repository_root = (entry as Partial<Source_Specification>).repository_root;
            if (typeof repository_root === 'string' && repository_root.length > 0) {
                roots.add(repository_root);
            }
        }
    }

    if (typeof raw.repository_root === 'string' && raw.repository_root.length > 0) {
        roots.add(raw.repository_root);
    }

    return distinct_repositories_from_sources(
        [...roots].map((repository_root) => ({
            host_path: repository_root,
            repository_root,
            source_prefix: '',
            mount_name: '',
        })),
    );
}

/**
 * Compute the in-memory map-shaped SHA field for a manifest read off disk.
 *
 * - When the new map field is present, use it as-is (legacy field discarded).
 * - When only the legacy single-key field is present, synthesize a single-entry
 *   map keyed on the primary repository, carrying the legacy value (including `null`).
 * - When neither shape is present, return an empty map `{}`. Callers MAY default
 *   missing per-repository entries to `null`.
 */
function synthesize_sha_map(
    new_map: Record<string, string | null> | undefined,
    legacy_value: string | null | undefined,
    primary_repository: string,
): Record<string, string | null> {
    if (new_map !== undefined && new_map !== null) {
        return { ...new_map };
    }

    return (legacy_value === undefined) ? {} : { [primary_repository]: legacy_value };
}

/**
 * Resolve the in-memory `sources` array from raw on-disk fields. Prefers the
 * new `sources` shape; falls back to synthesizing a single entry from the
 * legacy top-level `source_path`/`repository_root`/`source_prefix` triple.
 *
 * Validates the `host_path === path.join(repository_root, source_prefix)`
 * invariant on every entry. Manifests that carry neither shape are rejected.
 */
function resolve_sources_from_raw(
    raw: Partial<Sandbox_Manifest> & Legacy_Manifest_Fields,
    file_path: string,
): Source_Specification[] {
    if (Array.isArray(raw.sources) && raw.sources.length > 0) {
        return raw.sources.map((entry, index) => validate_source_specification(entry, index, file_path));
    }

    if (raw.source_path === undefined && raw.repository_root === undefined && raw.source_prefix === undefined) {
        throw new Error(
            `Manifest at ${file_path} declares neither a 'sources' array nor any legacy `
            + `'source_path'/'repository_root'/'source_prefix' field. At least one source is required.`
        );
    }

    return [synthesize_legacy_source(raw, file_path)];
}

function validate_source_specification(entry: unknown, index: number, file_path: string): Source_Specification {
    if (entry === null || typeof entry !== 'object') {
        throw new Error(`Manifest at ${file_path} sources[${index}] is not an object.`);
    }

    const candidate = entry as Partial<Source_Specification>;
    if (typeof candidate.host_path !== 'string'
        || typeof candidate.repository_root !== 'string'
        || typeof candidate.source_prefix !== 'string'
        || typeof candidate.mount_name !== 'string'
    ) {
        throw new TypeError(
            `Manifest at ${file_path} sources[${index}] is missing required fields. `
            + `Each entry requires host_path, repository_root, source_prefix, and mount_name (all strings).`
        );
    }

    const specification: Source_Specification = {
        host_path: candidate.host_path,
        repository_root: candidate.repository_root,
        source_prefix: candidate.source_prefix,
        mount_name: candidate.mount_name,
    };
    assert_host_path_join_invariant(specification, file_path, `sources[${index}]`);
    return specification;
}

function assert_host_path_join_invariant(
    entry: Source_Specification,
    file_path: string,
    location: string,
): void {
    const joined = path.join(entry.repository_root, entry.source_prefix);
    if (paths_equal_for_host(joined, entry.host_path)) {
        return;
    }

    throw new Error(
        `Manifest at ${file_path} ${location}: host_path (${entry.host_path}) `
        + `does not equal path.join(repository_root, source_prefix) (${path.join(entry.repository_root, entry.source_prefix)}). `
        + `The manifest may be tampered with or inconsistent.`
    );
}

/**
 * Synthesize a single `Source_Specification` from the legacy top-level
 * `source_path`/`repository_root`/`source_prefix` triple. `host_path` is
 * RECOMPUTED via `path.join(repository_root, source_prefix)` rather than
 * copied from legacy `source_path`, so the host_path invariant holds by
 * construction even on macOS (where `/var` is a symlink to `/private/var`
 * and the legacy writer may have stored either form).
 *
 * A `null` legacy `repository_root` is recomputed lazily by the caller (the
 * legacy-without-repository_root case is handled in `branch.ts` /
 * `sandbox/provisioning.ts`, which has the source_path on hand for the recomputation).
 * Here we synthesize what we can; if `repository_root` is missing entirely
 * we leave the synthesized entry with whatever the legacy file recorded so
 * the caller can detect and recompute.
 */
function synthesize_legacy_source(
    raw: Legacy_Manifest_Fields,
    file_path: string,
): Source_Specification {
    const legacy_source_path = raw.source_path;
    const legacy_repository_root = raw.repository_root ?? null;
    const legacy_source_prefix = raw.source_prefix ?? '';

    if (legacy_repository_root === null) {
        if (legacy_source_path === undefined) {
            throw new Error(
                `Manifest at ${file_path} carries no usable legacy source fields `
                + `(neither source_path nor repository_root).`
            );
        }

        // Defer recomputation to the caller — we need the source_path on disk to
        // run `git rev-parse --show-toplevel`. The caller (branch.ts /
        // src/sandbox/) re-derives repository_root and persists the new shape.
        return {
            host_path: legacy_source_path,
            repository_root: '',
            source_prefix: legacy_source_prefix,
            mount_name: legacy_source_prefix,
        };
    }

    // Check the legacy triple for internal consistency BEFORE recomputing
    // host_path. If source_path does not lie under repository_root, the
    // triple is corrupt and we surface a clear error rather than silently
    // replacing source_path with the join.
    if (legacy_source_path !== undefined) {
        assert_legacy_triple_consistent(
            legacy_source_path,
            legacy_repository_root,
            file_path,
        );
    }

    const recomputed_host_path = normalize_for_storage(
        path.join(legacy_repository_root, legacy_source_prefix),
    );
    return {
        host_path: recomputed_host_path,
        repository_root: legacy_repository_root,
        source_prefix: legacy_source_prefix,
        mount_name: legacy_source_prefix,
    };
}

function assert_legacy_triple_consistent(
    legacy_source_path: string,
    legacy_repository_root: string,
    file_path: string,
): void {
    // Validate the source_path/repository_root pair. The triple's third
    // member (`legacy_source_prefix`) is NOT cross-checked — legacy writers
    // normalized prefixes inconsistently across OSes, so the synthesized
    // entry recomputes host_path from repository_root + source_prefix and
    // uses the stored source_prefix as authoritative.
    const relative = path.relative(legacy_repository_root, legacy_source_path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
            `Manifest at ${file_path}: legacy source_path (${legacy_source_path}) `
            + `does not lie under repository_root (${legacy_repository_root}). `
            + `The legacy triple is inconsistent.`
        );
    }
}

export function write_manifest(
    sandbox_directory: string,
    manifest: Sandbox_Manifest
): void {
    for (const entry of manifest.sources) {
        assert_writer_source_specification_invariants(entry);
    }
    const file_path = manifest_path(sandbox_directory);
    atomic_write_file(file_path, JSON.stringify(manifest, null, 2));
}
