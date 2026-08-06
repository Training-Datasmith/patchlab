import * as fs from 'node:fs';
import { logger } from './logger.js';

/**
 * Declaration produced by Tool_Provider implementations that describes an
 * artifact the tool produces inside the sandbox (e.g., a conversation directory).
 *
 * Patchlab itself only reads/writes the file or directory at `container_path`;
 * its contents are opaque. The tool provider supplies the matching
 * `inject_session_state` to put the artifact back during resume.
 */
export interface Extractable_Artifact {
    /** Stable identifier (e.g., `"conversation"`). */
    name: string;
    /** Absolute path inside the sandbox container. */
    container_path: string;
    type: 'file' | 'directory';
    /**
     * Single path component (no separators, no `..`); the on-disk location is
     * `sessions/{n}/artifacts/<archive_subpath>`. Each provider's array SHALL
     * have unique values (case-insensitive ASCII comparison).
     */
    archive_subpath: string;
    /**
     * If true and the source path was produced during the prior session but is
     * missing from the archive, resume MUST fail. If the source path was never
     * produced (tool unused), resume proceeds without it.
     */
    required_for_resume: boolean;
}

/**
 * Windows-reserved characters that cannot appear in any path component on NTFS.
 * The validator enforces this on every host platform — the cross-platform
 * portability contract is what the validator defends.
 */
const WINDOWS_RESERVED_CHARACTERS = ['<', '>', ':', '"', '|', '?', '*'] as const;

/**
 * Windows-reserved device names. The check is exact-match (case-insensitive),
 * not substring — so `console-output` passes but `CON` does not.
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set<string>([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM0', 'COM1', 'COM2', 'COM3', 'COM4',
    'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4',
    'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Bad inputs the `archive_subpath` validator rejects, paired with the rule
 * that catches each. Exposed for use by other layers (e.g. the manifest-format
 * validator) so the rejection rule sets can be exercised against the same
 * fixture and remain aligned over time.
 */
export const ARCHIVE_SUBPATH_REJECTION_FIXTURE: readonly { value: string; rule: string }[] = [
    { value: '', rule: 'empty' },
    { value: '.', rule: 'navigation token' },
    { value: '..', rule: 'navigation token' },
    { value: '/etc/passwd', rule: 'separator' },
    { value: 'nested/dir', rule: 'separator' },
    { value: String.raw`nested\dir`, rule: 'separator' },
    { value: 'a/../b', rule: 'separator' },
    { value: 'foo\0bar', rule: 'control character' },
    { value: 'foo\x01bar', rule: 'control character' },
    { value: 'foo\x1fbar', rule: 'control character' },
    { value: 'tool:state', rule: 'Windows-reserved character' },
    { value: 'tool*state', rule: 'Windows-reserved character' },
    { value: 'tool?state', rule: 'Windows-reserved character' },
    { value: 'CON', rule: 'Windows-reserved device name' },
    { value: 'nul', rule: 'Windows-reserved device name' },
    { value: 'COM5', rule: 'Windows-reserved device name' },
    { value: 'CON.txt', rule: 'Windows-reserved device name' },
    { value: 'nul.log', rule: 'Windows-reserved device name' },
    { value: 'COM5.json', rule: 'Windows-reserved device name' },
    { value: 'foo.', rule: 'trailing dot' },
    { value: 'foo  ', rule: 'trailing space' },
];

function is_windows_reserved_device_name(value: string): boolean {
    // Windows reserves the stem, not the full name: CON.txt, nul.log, and
    // COM5.json are all device names. Match the portion before the first dot
    // (git's core.protectNTFS applies the same stem-only rule).
    const dot_index = value.indexOf('.');
    const stem = dot_index === -1 ? value : value.slice(0, dot_index);
    return WINDOWS_RESERVED_DEVICE_NAMES.has(stem.toUpperCase());
}

function contains_control_character(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code_point = value.codePointAt(index) ?? 0;
        if (code_point <= 0x1f) {
            return true;
        }
    }
    return false;
}

/**
 * Validate that `subpath` is safe to join under `sessions/{n}/artifacts/`.
 * Returns the input on success and throws with a descriptive error on rejection.
 *
 * The rules collectively form a strict superset of git's `core.protectNTFS`
 * portability defaults. They fire on EVERY host platform — patchlab's contract
 * is that a valid `archive_subpath` works on every supported platform without
 * surprise. Specifically rejected:
 *
 * 1. Empty string
 * 2. `.` or `..` (navigation tokens)
 * 3. Separators (`/` or `\`) — including `..` segments inside a longer subpath
 * 4. Null bytes or other control characters (`\x00`-`\x1f`)
 * 5. Windows-reserved characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`)
 * 6. Windows-reserved device names (case-insensitive): CON, PRN, AUX, NUL,
 *    COM0-COM9, LPT0-LPT9. Matched on the stem before the first dot —
 *    `console-output` passes but `CON.txt` and `nul.log` are rejected
 * 7. Trailing dot or space — Windows truncates these on filesystem write,
 *    which would silently collide with another subpath that lacks the trailing
 *    character. Mid-string dots and spaces are fine.
 *
 * `provider_name` is interpolated into error messages for diagnostic
 * attribution. The manifest-format parser passes the manifest's `name` field
 * (or the manifest filename when `name` failed to parse) here so a parse-time
 * rejection identifies the offending manifest the same way a runtime-time
 * rejection identifies the offending provider.
 */
export function validate_archive_subpath(subpath: string, provider_name: string): string {
    if (typeof subpath !== 'string') {
        throw new TypeError(
            `Provider "${provider_name}" declared an archive_subpath that is not a string: ${String(subpath)}.`
        );
    }

    if (subpath === '') {
        throw new Error(
            `Provider "${provider_name}" declared an empty archive_subpath. `
            + `archive_subpath must be a single non-empty path component.`
        );
    }

    if (subpath === '.' || subpath === '..') {
        throw new Error(
            `Provider "${provider_name}" declared archive_subpath="${subpath}" (a navigation token). `
            + `archive_subpath must be a single path component, not "." or "..".`
        );
    }

    if (subpath.includes('/') || subpath.includes('\\')) {
        throw new Error(
            `Provider "${provider_name}" declared archive_subpath="${subpath}" containing a path separator. `
            + String.raw`archive_subpath must be a single path component (no "/" or "\").`
        );
    }

    if (contains_control_character(subpath)) {
        throw new Error(
            `Provider "${provider_name}" declared archive_subpath containing a null byte or control character. `
            + `archive_subpath must contain only printable characters.`
        );
    }

    for (const character of WINDOWS_RESERVED_CHARACTERS) {
        if (subpath.includes(character)) {
            throw new Error(
                `Provider "${provider_name}" declared archive_subpath="${subpath}" containing the `
                + `Windows-reserved character "${character}". archive_subpath must work on every `
                + `supported host platform; reserved characters are <, >, :, ", |, ?, *.`
            );
        }
    }

    if (is_windows_reserved_device_name(subpath)) {
        throw new Error(
            `Provider "${provider_name}" declared archive_subpath="${subpath}" which matches a `
            + `Windows-reserved device name (CON, PRN, AUX, NUL, COM0-COM9, LPT0-LPT9). `
            + `archive_subpath must work on every supported host platform.`
        );
    }

    const last_character = subpath.at(-1);
    if (last_character === '.' || last_character === ' ') {
        throw new Error(
            `Provider "${provider_name}" declared archive_subpath="${subpath}" ending with a `
            + `${last_character === '.' ? 'dot' : 'space'}. Windows truncates trailing dots and `
            + `spaces on filesystem writes, which would cause silent collisions. archive_subpath `
            + `must not end with "." or " ".`
        );
    }

    return subpath;
}

/**
 * Throws when two or more artifacts in the array share an `archive_subpath`
 * under case-insensitive ASCII comparison. Case-insensitivity matches the
 * cross-platform contract: case-insensitive filesystems (Windows NTFS, macOS
 * HFS+ default) would silently overwrite on case-only-different subpaths.
 *
 * Diagnostic clarity: when a duplicate is detected, the error names the
 * provider, the case-collapsed duplicated subpath, and ALL conflicting
 * `artifact.name` values so the reader can locate every offending entry.
 */
export function assert_unique_archive_subpaths(
    artifacts: readonly Extractable_Artifact[],
    provider_name: string
): void {
    const seen = new Map<string, string[]>();
    for (const artifact of artifacts) {
        const key = artifact.archive_subpath.toLowerCase();
        const collisions = seen.get(key);
        if (collisions) {
            collisions.push(artifact.name);
        } else {
            seen.set(key, [artifact.name]);
        }
    }

    for (const [key, names] of seen.entries()) {
        if (names.length > 1) {
            throw new Error(
                `Provider "${provider_name}" declared duplicate archive_subpath="${key}" `
                + `(case-insensitive) across artifacts: ${names.join(', ')}. `
                + `Each artifact's archive_subpath must be unique within the provider's array.`
            );
        }
    }
}

/**
 * Throws when two or more artifacts in the array share a `name`. Comparison is
 * case-sensitive — `name` is a logical identifier used in error messages and
 * the extraction result interface, not a filesystem-bound value, so `Foo` and
 * `foo` are treated as distinct (mirror the case-insensitive treatment of
 * `archive_subpath` would over-reject without correctness benefit).
 *
 * Two artifacts sharing a `name` produce ambiguous logs (`extracted:
 * ['conversation', 'conversation']`) and confusing error messages with no
 * upside. The check is symmetrical with `assert_unique_archive_subpaths` and
 * runs alongside it at parse time and (defensively) at any host-boundary site
 * that ingests an artifact array from an untrusted source.
 */
export function assert_unique_artifact_names(
    artifacts: readonly Extractable_Artifact[],
    provider_name: string
): void {
    const seen = new Map<string, number>();
    for (const artifact of artifacts) {
        const count = seen.get(artifact.name) ?? 0;
        seen.set(artifact.name, count + 1);
    }

    for (const [name, count] of seen.entries()) {
        if (count > 1) {
            throw new Error(
                `Provider "${provider_name}" declared duplicate artifact name="${name}" `
                + `(${count} occurrences). Each artifact's name must be unique within the `
                + `provider's array — duplicates produce ambiguous error messages and logs.`
            );
        }
    }
}

/**
 * Discriminated outcome of a filesystem-type assertion against a declared
 * artifact's expected `'file' | 'directory'` shape.
 *
 * - `'present'`: path exists and matches the declared type
 * - `'absent'`: path does not exist (ENOENT, including ancestor-missing)
 * - `'mismatch'`: path exists but its on-disk type differs from the declared
 *   type. `actual` describes what was found.
 *
 * The function does NOT raise on mismatch; the caller decides — required
 * artifacts treat mismatch as fatal, optional artifacts as a warnable
 * absence.
 */
export type Filesystem_Type_Check_Result =
    | { kind: 'present' }
    | { kind: 'absent' }
    | { kind: 'mismatch'; actual: Filesystem_Actual_Type };

export type Filesystem_Actual_Type =
    | 'file'
    | 'directory'
    | 'symbolic_link'
    | 'fifo'
    | 'socket'
    | 'block_device'
    | 'character_device'
    | 'unknown';

function describe_actual_type(stats: fs.Stats): Filesystem_Actual_Type {
    if (stats.isSymbolicLink()) {
        return 'symbolic_link';
    }
    if (stats.isFile()) {
        return 'file';
    }
    if (stats.isDirectory()) {
        return 'directory';
    }
    if (stats.isFIFO()) {
        return 'fifo';
    }
    if (stats.isSocket()) {
        return 'socket';
    }
    if (stats.isBlockDevice()) {
        return 'block_device';
    }
    if (stats.isCharacterDevice()) {
        return 'character_device';
    }
    return 'unknown';
}

/**
 * Inspect `target_path` and classify it against the declared artifact type.
 * Uses `fs.lstatSync` so symbolic links report as `symbolic_link` rather than
 * being followed — the leaf must be the declared type itself, not a link to
 * a thing of that type.
 *
 * - `ENOENT` (leaf missing OR any ancestor missing) → `{ kind: 'absent' }`
 * - on-disk type matches declared type → `{ kind: 'present' }`
 * - on-disk type differs → `{ kind: 'mismatch', actual: <stringified actual> }`
 * - other errors (EACCES, etc.) → re-thrown so infrastructure failures
 *   surface separately from data inconsistency
 *
 * `provider_name` and `artifact_name` are accepted for diagnostic symmetry
 * with the other helpers, but the function itself never throws using them —
 * callers compose the names into their own error messages when reacting to
 * a `mismatch` result.
 */
export function assert_artifact_filesystem_type(
    target_path: string,
    declared_type: 'file' | 'directory',
    _provider_name: string,
    _artifact_name: string
): Filesystem_Type_Check_Result {
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(target_path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return { kind: 'absent' };
        }

        throw error;
    }

    const actual = describe_actual_type(stats);
    return ((declared_type === 'file' && actual === 'file')
           || (declared_type === 'directory' && actual === 'directory'))
        ? { kind: 'present' }
        : { kind: 'mismatch', actual };
}

/**
 * Apply the two-stage artifact-injection validation gate (uniqueness +
 * per-subpath validation) and return the artifacts that may proceed. On
 * uniqueness failure, ALL artifacts sharing a duplicated subpath are
 * skipped; remaining unique artifacts proceed. Per-subpath validation
 * rejections skip just the offending artifact. Each skip is logged so
 * operators can see which artifact(s) were dropped.
 */
export function filter_valid_artifacts_for_injection(
    artifacts: readonly Extractable_Artifact[],
    provider_name: string,
): Extractable_Artifact[] {
    const dropped_for_duplicates = collect_duplicate_artifact_names(artifacts, provider_name);

    const valid: Extractable_Artifact[] = [];
    for (const artifact of artifacts) {
        if (dropped_for_duplicates.has(artifact.name)) {
            continue;
        }

        try {
            validate_archive_subpath(artifact.archive_subpath, provider_name);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(`Warning: skipping injection of "${artifact.name}" — ${message}`);
            continue;
        }

        valid.push(artifact);
    }

    return valid;
}

/**
 * Return the names of artifacts whose `archive_subpath` collides with another
 * artifact's (case-insensitive). Empty set on success.
 */
function collect_duplicate_artifact_names(
    artifacts: readonly Extractable_Artifact[],
    provider_name: string,
): Set<string> {
    const dropped = new Set<string>();
    try {
        assert_unique_archive_subpaths(artifacts, provider_name);
        return dropped;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: ${message}`);
    }

    const names_by_subpath = new Map<string, string[]>();
    for (const artifact of artifacts) {
        const key = artifact.archive_subpath.toLowerCase();
        const names = names_by_subpath.get(key) ?? [];
        names.push(artifact.name);
        names_by_subpath.set(key, names);
    }

    for (const names of names_by_subpath.values()) {
        if (names.length > 1) {
            for (const name of names) {
                dropped.add(name);
            }
        }
    }

    return dropped;
}
