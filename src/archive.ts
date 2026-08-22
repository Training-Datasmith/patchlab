import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { read_manifest, type Sandbox_Manifest } from './manifest.js';
import type { Persisted_Resource_Limits_On_Disk } from './resource_limits.js';
import {
    assert_parsed_object_root,
    parse_file_as_json,
    require_number_field,
    require_string_field,
    validate_string_or_null_map,
} from './json_validators.js';
import { atomic_write_file } from './safe_filesystem.js';

/** Subdirectory of the user's home where all patchlab archives live. */
export const PATCHLAB_DIRECTORY = '.patchlab';

/**
 * Per-session fence directory under which all extractable artifacts are stored.
 * The on-disk layout is `sessions/{n}/artifacts/<archive_subpath>` — this
 * constant is the single source of truth for the fence name. Every site that
 * needs the literal SHALL import this constant; the literal `'artifacts'`
 * SHALL NOT appear inline anywhere else in the codebase.
 *
 * The fence is a patchlab-owned directory, not configurable by providers.
 * It namespaces extraction outputs from session metadata files and any other
 * patchlab-managed entries directly under `sessions/{n}/`.
 */
export const ARCHIVE_ARTIFACTS_DIRECTORY = 'artifacts';

/**
 * Aggregate read-only view of a patchlab on disk.
 *
 * Returned by `read_archive`. Modifications happen through targeted helpers
 * (`write_session_metadata`, `write_manifest`), not by mutating this object.
 *
 * Patchlab vs sandbox vs session:
 * - A patchlab is the persistent identity backing this archive.
 * - A sandbox is the ephemeral container associated with a session.
 * - A session is one injection/extraction pair within a patchlab.
 */
export interface Patchlab_Archive {
    id: string;
    manifest: Sandbox_Manifest;
    /** Sessions ordered by `session_number` ascending. */
    sessions: Session_Metadata[];
}

/**
 * On-disk schema for `sessions/{n}/metadata.json`.
 *
 * Fields are populated incrementally as the session progresses:
 * - `session_number`, `created_at`, `tool`, `container_name` are written when the sandbox starts.
 * - `commit_shas` is written by branch operations after the session's code-change commit
 *   (or carries `null` per repository if the session produced no code changes touching that repository).
 * - `completed_at` and `status` are written by the exit-extraction flow after history,
 *   conversation, and branch commit have been processed.
 *
 * Per-repository SHA / fallback fields are map-shaped — `commit_shas` and
 * `fallback_patches` are keyed on the patchlab's distinct `repository_root`
 * strings (one entry per repository in `manifest_repositories(manifest)`). Under
 * the current single-repository invariant every patchlab has exactly one
 * repository, so each map has one entry. The legacy single-key fields
 * `commit_sha` / `fallback_patch_path` are read-tolerated and synthesized
 * into single-entry maps (keyed on `manifest_primary_source(manifest).repository_root`)
 * on read. Writers emit only the map fields.
 *
 * Each layer that updates this file SHOULD use the read-modify-write pattern via
 * `read_session_metadata` then `write_session_metadata` to preserve fields populated by other layers.
 */
export interface Session_Metadata {
    session_number: number;
    created_at: string;
    completed_at: string | null;
    status: 'completed' | 'interrupted';
    tool: string | null;
    container_name: string | null;
    /**
     * Per-repository session commit SHA. Keys are the patchlab's distinct
     * `repository_root` strings; values are the SHA of the session's commit on
     * that repository's patchlab branch, or `null` when no commit was produced for
     * that repository. Under the current single-repository invariant this map has
     * exactly one entry.
     */
    commit_shas: Record<string, string | null>;
    /**
     * Per-repository fallback-patch path. Values are absolute paths to
     * `sessions/{n}/fallback.patch` when extraction wrote one for that repository
     * (the patchlab branch was missing, the diff exceeded the size cap, or
     * `git apply` rejected the diff). `null` when the auto-commit succeeded or
     * there was nothing to commit for that repository. Keys mirror `commit_shas`.
     */
    fallback_patches: Record<string, string | null>;
    /**
     * Resolved resource limits applied to this session's container at create
     * (or resume) time. `null` for sessions written by patchlab versions
     * predating the resource-limits feature — the resolver treats that case
     * as "no persisted layer" and falls through to lower-precedence sources.
     *
     * For `memory`/`cpus`/`pids`, a populated record stores either a concrete
     * value or the literal `"unlimited"` sentinel — never `null` in those
     * three fields, because runtime defaults always supply a concrete value
     * when nothing else is set. `blkio_weight` is the only field that can
     * legitimately be `null` (when no source provided a value at any
     * precedence, since `blkio_weight` has no runtime default).
     *
     * On-disk shape with bare keys (`memory`, `cpus`, `pids`, `blkio_weight`)
     * matches the spec's locked manifest schema. The in-memory resolver-side
     * shape uses `_limit`-suffixed names for readability; converters in
     * `resource_limits.ts` translate between the two at the boundary.
     */
    resource_limits: Persisted_Resource_Limits_On_Disk | null;
}

/** Root directory containing all patchlab archives. Persistent across reboots. */
export function patchlab_home_directory(): string {
    const override = process.env.PATCHLAB_HOME;
    if (override !== undefined && override !== '') {
        return override;
    }

    return os.homedir();
}

/** Root directory containing all patchlab archives. Persistent across reboots. */
export function build_archives_root(): string {
    return path.join(patchlab_home_directory(), PATCHLAB_DIRECTORY);
}

/**
 * Strict patchlab id check. Real ids come from `crypto.randomUUID()` and look like
 * `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (hex). Use this at the CLI trust boundary
 * to refuse anything else; throws on failure.
 *
 * Internal/library callers may use any id that passes `assert_safe_patchlab_id`.
 */
const PATCHLAB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assert_valid_patchlab_id(patchlab_id: string): void {
    if (!PATCHLAB_ID_PATTERN.test(patchlab_id)) {
        throw new Error(
            `Invalid patchlab id: "${patchlab_id}". `
            + `Expected a UUID like 11111111-2222-3333-4444-555555555555.`
        );
    }
}

/**
 * Defensive sanity check used wherever an id is interpolated into a filesystem,
 * git ref, or container path. Refuses path separators, `..`, leading `.`, and
 * empty strings — blocks traversal even when an id was supplied programmatically.
 */
export function assert_safe_patchlab_id(patchlab_id: string): void {
    if (!patchlab_id || typeof patchlab_id !== 'string') {
        throw new Error(`Patchlab id must be a non-empty string.`);
    }

    if (patchlab_id.includes('/') || patchlab_id.includes('\\')) {
        throw new Error(`Patchlab id contains a path separator: "${patchlab_id}".`);
    }

    if (patchlab_id === '.' || patchlab_id === '..' || patchlab_id.startsWith('.')) {
        throw new Error(`Patchlab id cannot start with a dot: "${patchlab_id}".`);
    }

    if (patchlab_id.includes('\0')) {
        throw new Error(`Patchlab id contains a null byte.`);
    }
}

/** Returns the absolute path under `~/.patchlab/{id}/`, optionally appending a subpath. */
export function build_archive_path(patchlab_id: string, subpath?: string): string {
    assert_safe_patchlab_id(patchlab_id);
    const base = path.join(build_archives_root(), patchlab_id);
    return subpath === undefined ? base : path.join(base, subpath);
}

/** Returns the absolute path under `sessions/{n}/`, optionally appending a subpath. */
export function build_session_path(
    patchlab_id: string,
    session: number,
    subpath?: string
): string {
    const base = path.join(build_archive_path(patchlab_id), 'sessions', String(session));
    return subpath === undefined ? base : path.join(base, subpath);
}

/**
 * Resolve `input` to the canonical on-disk path, following symlinks when the
 * target exists. On Windows, normalizes separator spelling and prefers the
 * native realpath implementation so 8.3 short names (for example `RUNNER~1`)
 * and long-path forms compare equal. Non-existent paths fall back to
 * `path.resolve`.
 */
export function canonical_host_path(input: string): string {
    let resolved = path.resolve(input);
    if (process.platform === 'win32') {
        resolved = resolved.replaceAll('/', '\\');
        try {
            const realpath_sync = fs.realpathSync as typeof fs.realpathSync & {
                native?: (target: fs.PathLike) => string;
            };
            if (typeof realpath_sync.native === 'function') {
                return realpath_sync.native(resolved);
            }
            return fs.realpathSync(resolved);
        } catch (_path_missing) {
            return resolved;
        }
    }

    try {
        return fs.realpathSync(resolved);
    } catch (_path_missing) {
        return resolved;
    }
}

/**
 * Locate the host git repository root containing `source_path`.
 * Throws if the path is not inside a git repository.
 *
 * Git reports the root with platform-native spelling (forward slashes on every
 * host; 8.3 short names on some Windows runners). Canonicalize through
 * `realpathSync` so callers compare and relativize against the same on-disk
 * location as `fs.realpathSync` on source paths.
 */
export function get_repository_root(source_path: string): string {
    const resolved = path.resolve(source_path);
    try {
        const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: resolved,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
        });
        return canonical_host_path(output.trim());
    } catch (_not_a_git_repository) {
        throw new Error(
            `Source path is not inside a git repository: ${resolved}. ` +
            `Patchlab requires the source to be in a git repository so the patchlab branch can be created.`
        );
    }
}

/**
 * Compute the relative path from `repository_root` to `source_path` with no
 * trailing slash. Returns `""` if `source_path` is the repository root.
 */
export function get_source_prefix(
    repository_root: string,
    source_path: string
): string {
    const repository = canonical_host_path(repository_root);
    const source = canonical_host_path(source_path);
    const relative = path.relative(repository, source);
    if (relative === '' || relative === '.') {
        return '';
    }

    // Normalize path separators to forward slashes for portability across platforms.
    return relative.replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * Read the next available session number for a patchlab.
 * Returns 1 if no sessions exist; otherwise max(existing) + 1.
 *
 * The read-then-allocate sequence is not atomic; callers must serialize concurrent
 * allocation against the same patchlab. The one-sandbox-per-session guard provides
 * this serialization in normal use.
 */
export function next_session_number(patchlab_id: string): number {
    const sessions_directory = path.join(build_archive_path(patchlab_id), 'sessions');
    if (!fs.existsSync(sessions_directory)) {
        return 1;
    }

    const entries = fs.readdirSync(sessions_directory, { withFileTypes: true });
    let max = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const n = Number(entry.name);
        if (Number.isInteger(n) && n > max) {
            max = n;
        }
    }

    return max + 1;
}

const SESSION_METADATA_FILENAME = 'metadata.json';

function session_metadata_path(patchlab_id: string, session: number): string {
    return build_session_path(patchlab_id, session, SESSION_METADATA_FILENAME);
}

/**
 * Return the highest session number that has a written `metadata.json`, or
 * `null` when none exists. Prefer this over `next_session_number(...) - 1` when
 * you mean "the last COMPLETED session": a session directory is claimed (mkdir)
 * before its initial metadata is written (see write_initial_session_metadata),
 * so a session that was claimed by a concurrent create/resume or abandoned by a
 * crash exists as a metadata-less directory. `next - 1` would point at that
 * empty directory and mistake it for the previous session, losing the real
 * prior session's persisted state; this scan skips it. Metadata is written
 * atomically, so presence of the file implies it is complete.
 */
export function latest_session_with_metadata(patchlab_id: string): number | null {
    const sessions_directory = path.join(build_archive_path(patchlab_id), 'sessions');
    if (!fs.existsSync(sessions_directory)) {
        return null;
    }

    const session_numbers = fs.readdirSync(sessions_directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => Number(entry.name))
        .filter((session) => Number.isInteger(session) && session >= 1)
        .sort((left, right) => right - left);
    for (const session of session_numbers) {
        if (fs.existsSync(session_metadata_path(patchlab_id, session))) {
            return session;
        }
    }

    return null;
}

/** Write session metadata atomically (temp file then rename). */
export function write_session_metadata(
    patchlab_id: string,
    session: number,
    metadata: Session_Metadata
): void {
    const directory = build_session_path(patchlab_id, session);
    fs.mkdirSync(directory, { recursive: true });
    const file_path = session_metadata_path(patchlab_id, session);
    atomic_write_file(file_path, JSON.stringify(metadata, null, 2));
}

interface Legacy_Session_Metadata_Fields {
    commit_sha?: string | null;
    fallback_patch_path?: string | null;
}

/**
 * Read session metadata; returns `null` if the session directory does not exist.
 * Applies legacy defaults for fields absent in older metadata files.
 *
 * Per-repository `commit_shas` / `fallback_patches` maps are synthesized from the
 * legacy single-key `commit_sha` / `fallback_patch_path` fields when only the
 * legacy shape is present on disk. The synthesized key is the patchlab's
 * primary repository (`manifest.sources[0].repository_root`), resolved
 * internally by reading the manifest — callers no longer pass it.
 */
export function read_session_metadata(
    patchlab_id: string,
    session: number,
): Session_Metadata | null {
    const file_path = session_metadata_path(patchlab_id, session);
    if (!fs.existsSync(file_path)) {
        return null;
    }

    const parsed: unknown = parse_file_as_json(file_path);
    const raw = assert_parsed_object_root(parsed, file_path);
    const raw_legacy = raw as Partial<Session_Metadata> & Legacy_Session_Metadata_Fields;

    // Validate the on-disk schema (required scalars and SHA-map shapes)
    // before invoking the SHA-map synthesizers. Synthesis can trigger a
    // manifest read via `lazy_primary_repository`; if the metadata file is
    // corrupt the schema error must surface ahead of any unrelated
    // filesystem failure from that lookup.
    const session_number = require_number_field(raw, 'session_number', file_path);
    const created_at = require_string_field(raw, 'created_at', file_path);
    const validated_commit_shas = validate_string_or_null_map(raw.commit_shas, 'commit_shas', file_path);
    const validated_fallback_patches = validate_string_or_null_map(raw.fallback_patches, 'fallback_patches', file_path);

    // Defer the manifest read until a synthesis branch actually needs the
    // primary repository — non-legacy reads (the common case) skip it.
    let cached_primary_repository: string | null = null;
    const lazy_primary_repository = (): string => {
        cached_primary_repository ??= resolve_primary_repository_for_synthesis(patchlab_id);

        return cached_primary_repository;
    };
    const commit_shas = synthesize_session_sha_map(validated_commit_shas, raw_legacy.commit_sha, lazy_primary_repository);
    const fallback_patches = synthesize_session_sha_map(validated_fallback_patches, raw_legacy.fallback_patch_path, lazy_primary_repository);

    return {
        session_number,
        created_at,
        completed_at: raw_legacy.completed_at ?? null,
        status: raw_legacy.status ?? 'completed',
        tool: raw_legacy.tool ?? null,
        container_name: raw_legacy.container_name ?? null,
        commit_shas,
        fallback_patches,
        // Whole-block-absent is distinct from any in-block field being null
        // or "unlimited"; sessions written by patchlab versions predating
        // the resource-limits feature read as `null` here, and the resolver
        // treats that as "no persisted layer for any field."
        resource_limits: raw_legacy.resource_limits ?? null,
    };
}

/**
 * Synthesize the per-repository map for `commit_shas` / `fallback_patches`. Rules:
 * - New map non-empty → use as-is (legacy field discarded).
 * - New map present but empty (`{}`) → repopulate to `{ [primary_repo]: null }`.
 *   Per the `Session metadata schema` requirement's "rewritten to the populated
 *   null shape on the next mutation" clause: the empty map is tolerated as
 *   input but the in-memory representation is the populated null shape so any
 *   subsequent writer persists it.
 * - Only legacy single-key field present → single-entry map keyed on `primary_repo`.
 * - Neither present → `{ [primary_repo]: null }` (same populated-null shape).
 */
function synthesize_session_sha_map(
    new_map: Record<string, string | null> | undefined,
    legacy_value: string | null | undefined,
    primary_repository: () => string,
): Record<string, string | null> {
    if (new_map !== undefined && new_map !== null) {
        return Object.keys(new_map).length === 0
            ? { [primary_repository()]: null }
            : { ...new_map };
    }

    return (legacy_value === undefined)
        ? { [primary_repository()]: null }
        : { [primary_repository()]: legacy_value };
}

/**
 * Resolve the primary repository for legacy-synthesis purposes — derived from
 * the patchlab's manifest at read time. Used inside `read_session_metadata` so
 * callers no longer thread the value through. The redundant manifest read
 * (when the caller already loaded it) is negligible: the manifest is small and
 * the OS file cache handles repeated reads.
 */
function resolve_primary_repository_for_synthesis(patchlab_id: string): string {
    const directory = build_archive_path(patchlab_id);
    const manifest = read_manifest(directory);
    return manifest.sources[0].repository_root;
}

/**
 * Load the full archive for a patchlab: manifest plus all sessions ordered by session_number.
 * Validates `format_version` via `read_manifest`.
 */
export function read_archive(patchlab_id: string): Patchlab_Archive {
    const directory = build_archive_path(patchlab_id);
    const manifest = read_manifest(directory);
    const sessions: Session_Metadata[] = [];

    const sessions_directory = path.join(directory, 'sessions');
    if (fs.existsSync(sessions_directory)) {
        const entries = fs
            .readdirSync(sessions_directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => Number(entry.name))
            .filter((n) => Number.isInteger(n))
            .sort((a, b) => a - b);

        for (const n of entries) {
            const metadata = read_session_metadata(patchlab_id, n);
            if (metadata) {
                sessions.push(metadata);
            }
        }
    }

    return {
        id: patchlab_id,
        manifest,
        sessions,
    };
}
