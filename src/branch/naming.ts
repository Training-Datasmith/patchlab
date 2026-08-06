/**
 * Naming policy for the patchlab branch namespace.
 *
 * Every host repository branch created by patchlab lives under
 * `${PATCHLAB_BRANCH_PREFIX}{id}`. `patchlab_branch_name(id)` composes the
 * name; `patchlab_id_from_branch_name(branch)` is the inverse parser. Callers
 * that iterate the branch list (e.g., orphan-branch GC) use the prefix for the
 * `git for-each-ref` glob and the parser to recover the id from each match.
 */
import { assert_safe_patchlab_id } from '../archive.js';

/**
 * Branch-name namespace prefix shared by every patchlab branch.
 */
export const PATCHLAB_BRANCH_PREFIX = 'patchlab/';

/** Compose the patchlab branch name. */
export function patchlab_branch_name(patchlab_id: string): string {
    assert_safe_patchlab_id(patchlab_id);
    return `${PATCHLAB_BRANCH_PREFIX}${patchlab_id}`;
}

/**
 * Inverse of `patchlab_branch_name`: strip the `patchlab/` prefix off a
 * branch name to recover the patchlab id. Caller is responsible for already
 * having filtered to branches that start with `PATCHLAB_BRANCH_PREFIX` (e.g.,
 * via `git for-each-ref refs/heads/${PATCHLAB_BRANCH_PREFIX}`).
 */
export function patchlab_id_from_branch_name(branch: string): string {
    return branch.substring(PATCHLAB_BRANCH_PREFIX.length);
}
