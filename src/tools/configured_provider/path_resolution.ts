/**
 * Host- and container-side path expansion for configured tool-provider
 * manifests.
 *
 * Path expansion runs at PARSE time (not run time): `~`, `$HOME`, and
 * `$VARIABLE_NAME` are resolved against the host environment when the
 * manifest is loaded, so the resulting `Configured_Tool_Provider_Manifest`
 * carries already-resolved paths. Per-source manifests additionally pass
 * each `authentication.copies[*].host` through
 * `assert_host_path_within_source` to enforce the containment rule.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    fail,
    reject_null_bytes,
    WINDOWS_DRIVE_LETTER_REGEX,
} from './validators.js';
import { host_is_case_insensitive, is_path_within } from '../../path_containment.js';
import type { Manifest_Parse_Error } from './types.js';

const VARIABLE_NAME_REGEX = /\$([A-Za-z_]\w*)/g;

/**
 * Expand a host path. Rules:
 *   - Leading `~`/`~/...` → `os.homedir()`.
 *   - `~user` (other-user home) is REJECTED.
 *   - Leading `$HOME` → `os.homedir()`.
 *   - `$VARIABLE_NAME` (anywhere in the path, multiple supported) →
 *     `process.env[name]`. Undefined fails; empty-string expands to `""`.
 *   - Absolute paths (POSIX or Windows drive-letter) → passed through.
 *   - Plain relative paths → resolved against `manifest_directory`.
 *
 * The resolved value SHALL NOT contain null bytes (rejected if it does).
 */
export function expand_host_path(
    value: string,
    manifest_directory: string,
    field: string,
    homedir_resolver: () => string | null = () => os.homedir()
): string {
    if (value === '') {
        fail(field, 'must not be empty');
    }

    // Reject ~user (other-user home expansion).
    if (value.startsWith('~') && value.length > 1 && value[1] !== '/' && value[1] !== '\\') {
        fail(field, '~user (other-user home) syntax is not supported; use an absolute path or $VAR reference');
    }

    let resolved = value;

    // Leading-position ~ and $HOME → os.homedir().
    if (resolved === '~' || resolved.startsWith('~/') || resolved.startsWith('~\\')) {
        const home = homedir_resolver();
        if (!home) {
            fail(field, 'host home directory could not be determined (HOME unset and user database lookup failed)');
        }
        resolved = home + resolved.slice(1);
    } else if (resolved === '$HOME' || resolved.startsWith('$HOME/') || resolved.startsWith('$HOME\\')) {
        const home = homedir_resolver();
        if (!home) {
            fail(field, 'host home directory could not be determined (HOME unset and user database lookup failed)');
        }

        resolved = home + resolved.slice('$HOME'.length);
    }

    // $VARIABLE_NAME expansion (anywhere; supports multiple segments).
    resolved = resolved.replaceAll(VARIABLE_NAME_REGEX, (_match, name: string) => {
        const environment_value = process.env[name];
        if (environment_value === undefined) {
            fail(field, `unresolved environment variable: $${name} (not set in host environment)`);
        }

        return environment_value;
    });

    reject_null_bytes(resolved, field);

    // Absolute paths and now-resolved paths pass through; remaining relatives anchor to manifest dir.
    if (path.isAbsolute(resolved) || WINDOWS_DRIVE_LETTER_REGEX.test(resolved)) {
        return resolved;
    }

    return path.resolve(manifest_directory, resolved);
}

// --- Per-source host-path containment --------------------------------------

export interface Host_Path_Containment_Options {
    /** Override case-sensitivity for tests. Default: `process.platform === 'win32'`. */
    case_insensitive?: boolean;
    /**
     * Index of the offending entry within `authentication.copies` — used to
     * build a precise `field_path` for the rejection. Defaults to a generic
     * `authentication.copies[*].host` when omitted.
     */
    field_index?: number;
    /**
     * Optional realpath resolver override for tests. Defaults to
     * `fs.realpathSync`. Returning a value that throws is treated the same as
     * the live filesystem layer's `ENOENT`/`EACCES` responses.
     */
    realpath_resolver?: (input: string) => string;
}

/**
 * Verify that `absolute_host_path` (already expanded, already absolute) lies
 * within `repository_root`. Per-source manifests SHALL NOT copy files from
 * outside the repository tree — hard policy, no override flag. Under the
 * single-repository invariant established by `sandbox-lifecycle`, every
 * patchlab has exactly one `repository_root` regardless of how many sources
 * it mounts; this check anchors the containment at that root rather than at
 * any individual mounted source.
 *
 * Two evaluations, BOTH must succeed:
 *
 *   1. **Lexical** — `path.resolve` on both endpoints, then compare. Reject if
 *      the host path doesn't share the repository as a prefix component
 *      (different Windows drive, `..` escape, absolute external path).
 *   2. **Realpath** — `fs.realpathSync` on both endpoints (the longest
 *      existing prefix when the host path itself is missing). Re-apply the
 *      lexical comparison to the realpath outputs. Catches symlinks inside
 *      the repository tree pointing outward and NTFS junctions / reparse
 *      points that lexically appear contained but actually escape.
 *
 * On case-insensitive filesystems (Windows and macOS by default), the
 * comparison is case-insensitive; on case-sensitive filesystems it's
 * case-sensitive. Both legs normalize separators (`/` vs `\`) before
 * comparison. Comparison is delegated to the shared host-aware
 * `is_path_within` (see src/path_containment.ts).
 *
 * User-global manifests are NOT subject to this check — the caller passes
 * each per-source manifest's `authentication.copies[*].host` through this
 * function as part of per-source registration. On rejection, returns a
 * `Manifest_Parse_Error` shaped for `format_warning(...)` consumption; on
 * success, returns `null`.
 */
export function assert_host_path_within_source(
    absolute_host_path: string,
    repository_root: string,
    manifest_path: string,
    options?: Host_Path_Containment_Options,
): Manifest_Parse_Error | null {
    const case_insensitive = options?.case_insensitive ?? host_is_case_insensitive();
    const field_path = options?.field_index === undefined
        ? 'authentication.copies[*].host'
        : `authentication.copies[${options.field_index}].host`;
    const realpath_resolver = options?.realpath_resolver ?? ((input) => fs.realpathSync(input));

    const normalized_repository = path.resolve(repository_root);
    const normalized_host = path.resolve(absolute_host_path);

    // Lexical leg: reject any path that doesn't fall under repository_root.
    if (!is_path_within(normalized_host, normalized_repository, case_insensitive)) {
        return {
            manifest_path,
            field_path,
            reason:
                `host path '${absolute_host_path}' resolves outside repository tree '${repository_root}'. `
                + `Per-source manifests cannot copy files from outside the repository tree. `
                + `Use a user-global manifest if cross-tree access is needed.`,
        };
    }

    // Realpath leg: defend against symlink / junction bypass. If either
    // endpoint's real path cannot be resolved (EACCES or another filesystem
    // error — NOT a missing tail, which resolves lexically), fail the check
    // CLOSED: we cannot prove containment, so reject rather than fall back to
    // the lexical result an escape could have satisfied.
    let real_repository: string;
    let real_host: string;
    try {
        real_repository = resolve_realpath_or_existing_prefix(normalized_repository, realpath_resolver);
        real_host = resolve_realpath_or_existing_prefix(normalized_host, realpath_resolver);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        return {
            manifest_path,
            field_path,
            reason:
                `host path '${absolute_host_path}' could not be verified against repository tree `
                + `'${repository_root}': resolving its real path failed (${code}). Rejected to `
                + `avoid a symlink / NTFS junction that escapes the tree behind an unreadable component.`,
        };
    }

    return is_path_within(real_host, real_repository, case_insensitive) ? null : {
            manifest_path,
            field_path,
            reason:
                `host path '${absolute_host_path}' resolves (via realpath / symlink`
                + ` target) outside repository tree '${repository_root}'. Symlinks and NTFS`
                + ` junctions whose targets escape the repository tree are rejected.`,
        };
}

/**
 * Return `fs.realpathSync(absolute_path)` when the path exists. When the
 * path's tail is missing, walk upward to find the longest existing prefix,
 * realpath that, then re-append the missing tail. Used so the containment
 * check works for host paths that point at not-yet-created files (e.g. an
 * `authentication.copies[*].host: ./template.json` where `template.json` is
 * generated at build time).
 */
function resolve_realpath_or_existing_prefix(
    absolute_path: string,
    realpath_resolver: (input: string) => string,
): string {
    const missing_segments: string[] = [];
    let current = absolute_path;
    while (true) {
        try {
            const real_prefix = realpath_resolver(current);
            if (missing_segments.length === 0) {
                return real_prefix;
            }

            const tail = [...missing_segments].reverse();
            return path.join(real_prefix, ...tail);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                // EACCES or other filesystem error while resolving the real
                // path: do NOT silently fall back to a lexical-only result.
                // The realpath leg exists specifically to catch symlinks /
                // junctions that escape the tree; degrading it to lexical here
                // would let an escape hide behind an unreadable component.
                // Propagate so the caller fails the containment check closed.
                throw error;
            }

            const parent = path.dirname(current);
            if (parent === current) {
                // Walked all the way up without finding an existing prefix.
                return absolute_path;
            }

            missing_segments.push(path.basename(current));
            current = parent;
        }
    }
}

/**
 * Expand a container path. Rules:
 *   - Leading `~`/`~/...` and `$HOME` → `manifest.image_home` (already
 *     resolved to an absolute Linux path at parse time).
 *   - Absolute paths starting with `/` → passed through.
 *   - Other `$VARIABLE_NAME` references → REJECTED (unresolvable at parse
 *     time; the container does not exist yet).
 *   - Plain relative paths → REJECTED (no stable container-side anchor).
 */
export function expand_container_path(
    value: string,
    image_home: string,
    field: string
): string {
    if (value === '') {
        fail(field, 'must not be empty');
    }

    if (value.startsWith('~') && value.length > 1 && value[1] !== '/') {
        fail(field, '~user (other-user home) syntax is not supported; use an absolute path or $HOME-relative path');
    }

    let resolved: string;
    if (value === '~' || value.startsWith('~/')) {
        resolved = image_home + value.slice(1);
    } else if (value === '$HOME' || value.startsWith('$HOME/')) {
        resolved = image_home + value.slice('$HOME'.length);
    } else {
        resolved = value;
    }

    if (resolved.includes('$')) {
        // Reject before the absolute-path branch: an absolute path containing
        // `$VAR` (e.g., `/etc/$RUNTIME_DIR/socket`) would otherwise smuggle an
        // unresolved variable past the parser.
        fail(field, 'container paths only expand `~` and `$HOME`; other `$VAR` references are not resolvable at manifest load time. Use an absolute path or $HOME-relative path');
    } else if (!resolved.startsWith('/')) {
        fail(field, 'container paths must be absolute (start with /) or $HOME-relative (~/foo or $HOME/foo); plain relative paths have no stable container-side anchor');
    }

    reject_null_bytes(resolved, field);
    return resolved;
}