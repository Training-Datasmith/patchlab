/**
 * Host-aware path comparison. Three call sites previously each rolled their own
 * "is A under/equal B" logic with subtly different rules (separator handling and
 * case-folding diverged — notably, only some folded case on macOS), so the same
 * containment question could get a different answer per module on a
 * case-insensitive host. This module is the single source of truth.
 *
 * These comparisons are LEXICAL — they do not resolve symlinks, nor do they
 * collapse `.`/`..` segments. Callers that need a security boundary (e.g.
 * rejecting NTFS junctions that escape a tree, or a `..` climb out of it) must
 * `path.resolve` and/or realpath their inputs first and then compare here.
 */

/**
 * Whether the host filesystem is case-insensitive. Windows (`win32`) and macOS
 * (`darwin`) default to case-insensitive; everything else is treated as
 * case-sensitive.
 */
export function host_is_case_insensitive(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
}

/**
 * Normalize a path for comparison: unify separators to `/`, strip all trailing
 * separators (flooring at the root `/`), and fold case when the host is
 * case-insensitive. NOT for normalizing a path that will be stored — folding
 * case would corrupt the stored value; use a separator-only normalizer for
 * that.
 */
function normalize_for_compare(value: string, case_insensitive: boolean): string {
    let normalized = value.replaceAll('\\', '/');
    // Trailing separators are insignificant: `/repo`, `/repo/`, and `/repo//`
    // all denote the same path, so strip them all. Floor the result at the
    // root `/` — an all-slashes input ('//') must NOT collapse to the empty
    // string, which would then match every absolute path as a containment
    // parent.
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.replace(/\/+$/, '');
        if (normalized === '') {
            normalized = '/';
        }
    }

    // `toLowerCase` approximates the host's case-insensitive comparison; it is
    // NOT byte-exact to NTFS's invariant case folding or APFS/HFS+'s fold table.
    // For the ASCII paths patchlab handles these agree; an exotic Unicode path
    // could fold differently than the OS does — an accepted limitation here.
    return case_insensitive ? normalized.toLowerCase() : normalized;
}

/** True when `left` and `right` denote the same path under host case/separator rules. */
export function paths_equal_for_host(
    left: string,
    right: string,
    case_insensitive: boolean = host_is_case_insensitive(),
): boolean {
    return normalize_for_compare(left, case_insensitive)
        === normalize_for_compare(right, case_insensitive);
}

/**
 * True when `candidate` is the same path as `parent` or lies strictly beneath
 * it, under host case/separator rules. Inputs may use either separator and may
 * carry a trailing separator; both are normalized before comparison.
 */
export function is_path_within(
    candidate: string,
    parent: string,
    case_insensitive: boolean = host_is_case_insensitive(),
): boolean {
    const candidate_normalized = normalize_for_compare(candidate, case_insensitive);
    const parent_normalized = normalize_for_compare(parent, case_insensitive);
    if (candidate_normalized === parent_normalized) {
        return true;
    }

    const parent_with_separator = parent_normalized.endsWith('/')
        ? parent_normalized
        : parent_normalized + '/';

    return candidate_normalized.startsWith(parent_with_separator);
}
