/**
 * Read-only queries against a patchlab branch. The "what does this branch
 * contain?" family — diffs, file lists — with no mutation of the host
 * repository.
 *
 * Two families live here together:
 *
 *   - **Diff readers**: `read_cumulative_diff`, `read_commit_diff`,
 *     `compose_diff_against_baseline_with_pending`, and the shared
 *     `resolve_diff_start_reference` helper. Used by `patches.ts`,
 *     `changes.ts`, and the extraction flow to render diff strings.
 *   - **File listing**: `list_branch_files` and its empty-prefix
 *     fast path. Used by the resume host-overlay logic to compute the
 *     exclusion set of paths that already live on the branch tip.
 *
 * Grouped because both families share the same shape — `git ls-tree`,
 * `git diff`, `git merge-base` queries against a branch — and never mutate
 * the host's index, working tree, or refs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { safe_unlink } from '../safe_filesystem.js';
import { run_git, list_other_local_branches } from './internals.js';
import { patchlab_branch_name } from './naming.js';
import { branch_exists, patchlab_branch_exists } from './predicates.js';

/**
 * Read the unified diff for the cumulative range from the branch starting point to
 * `patchlab/{id}`'s tip.
 *
 * The starting point is selected in priority order:
 *   1. `baseline_commit_sha` if present (range = `baseline..tip`)
 *   2. `branch_creation_point_sha` if present (range = `creation_point..tip`)
 *   3. heuristic merge-base against any other local branch (legacy fallback)
 *
 * If no starting point can be derived, returns an empty string.
 */
export function read_cumulative_diff(
    repository_root: string,
    patchlab_id: string,
    baseline_commit_sha: string | null,
    branch_creation_point_sha: string | null = null
): string {
    const start_reference = resolve_diff_start_reference(
        repository_root,
        patchlab_id,
        baseline_commit_sha,
        branch_creation_point_sha
    );
    if (!start_reference) {
        return '';
    }

    const branch = patchlab_branch_name(patchlab_id);
    const result = run_git(
        ['diff', '--binary', `${start_reference}..${branch}`], { cwd: repository_root });

    return result.stdout;
}

/**
 * Resolve the starting commit SHA for a patchlab's cumulative-diff range. Returns
 * `null` when no starting point can be derived (legacy archive with no baseline,
 * no branch_creation_point, and no other local branches to merge-base against).
 *
 * Throws when the patchlab branch itself does not exist — the caller cannot
 * meaningfully proceed without it.
 *
 * Exported separately so other diff-rendering paths (e.g., `patches.ts`'s
 * worktree-based pending-diff composition) can resolve the same starting ref
 * without re-running the cumulative-diff query.
 */
export function resolve_diff_start_reference(
    repository_root: string,
    patchlab_id: string,
    baseline_commit_sha: string | null,
    branch_creation_point_sha: string | null = null
): string | null {
    const branch = patchlab_branch_name(patchlab_id);
    if (!patchlab_branch_exists(repository_root, patchlab_id)) {
        throw new Error(
            `Patchlab branch ${branch} does not exist in ${repository_root}.`
        );
    }

    return baseline_commit_sha
        ?? branch_creation_point_sha
        ?? find_branch_creation_point(repository_root, branch);
}

/**
 * Compose a single coherent diff covering committed sessions on the patchlab
 * branch PLUS a `pending_patch` (typically the live container's working-tree
 * diff against its HEAD). The patchlab branch tip and the container's HEAD
 * reference the same tree by construction (`initialize_sandbox_git_baseline`
 * commits the host's tip tree as the container's baseline), so the pending
 * patch applies cleanly against a host worktree checked out at the branch tip.
 *
 * Mechanism: a temporary worktree at `patchlab/{id}` tip is created, the
 * pending patch is applied to it via `git apply --index` (updates worktree AND
 * index in one step, so blob hashes line up), and `git diff --cached
 * <start_reference>` produces the cumulative diff `start_reference → tip+pending`
 * as a single coherent rendering. The temp worktree is removed unconditionally
 * on return.
 *
 * Throws when `git apply` rejects the pending patch — that signals the
 * container's diff was malformed or its HEAD has drifted from the tip
 * (shouldn't happen under normal flow, but the failure is loud rather than
 * silently absorbed).
 */
export function compose_diff_against_baseline_with_pending(
    repository_root: string,
    patchlab_id: string,
    start_reference: string,
    pending_patch: Buffer
): string {
    const branch = patchlab_branch_name(patchlab_id);
    // Use a unique worktree path that doesn't yet exist — `git worktree add`
    // requires the destination to be absent.
    const worktree_path = path.join(
        os.tmpdir(),
        `patchlab-diff-wt-${crypto.randomBytes(8).toString('hex')}`
    );
    const patch_file = path.join(
        os.tmpdir(),
        `patchlab-pending-${crypto.randomBytes(8).toString('hex')}.patch`
    );

    let worktree_added = false;
    try {
        run_git(
            ['worktree', 'add', '--detach', '-q', worktree_path, branch],
            { cwd: repository_root }
        );
        worktree_added = true;

        // Write the byte-exact pending diff (no encoding) so `git apply` ingests
        // the same bytes the container produced — a UTF-8 round-trip here would
        // corrupt latin1/non-UTF-8 hunks and make apply reject.
        fs.writeFileSync(patch_file, pending_patch);
        run_git(['apply', '--index', patch_file], { cwd: worktree_path });

        const result = run_git(['diff', '--binary', '--cached', start_reference], { cwd: worktree_path });
        return result.stdout;
    } finally {
        safe_unlink(patch_file);

        if (worktree_added) {
            try {
                run_git(
                    ['worktree', 'remove', '--force', worktree_path],
                    { cwd: repository_root }
                );
            } catch (_worktree_remove_failed) {
                // If `git worktree remove` itself fails, force-rm the directory and
                // let the next `git worktree prune` clean up the stale bookkeeping.
                try {
                    fs.rmSync(worktree_path, { recursive: true, force: true });
                } catch (_worktree_force_rm_failed) {
                    /* best-effort */
                }
            }
        } else {
            // `git worktree add` failed before allocating; just rm any debris.
            try {
                fs.rmSync(worktree_path, { recursive: true, force: true });
            } catch (_worktree_force_rm_failed) {
                /* best-effort */
            }
        }
    }
}

/** Read the unified diff for a single commit (its delta vs. its first parent). */
export function read_commit_diff(repository_root: string, commit_sha: string): string {
    const result = run_git(
        ['diff', '--binary', `${commit_sha}^!`],
        { cwd: repository_root }
    );
    return result.stdout;
}

function find_branch_creation_point(repository_root: string, branch: string): string | null {
    // Return the FIRST successful merge-base against any other local branch.
    // (Not necessarily the one closest to the tip — the first match wins; a
    // closest-to-tip selection would need `rev-list --count` ranking of the
    // candidates, which the callers do not require.)
    const others = list_other_local_branches(repository_root, branch);
    for (const other of others) {
        const result = run_git(
            ['merge-base', branch, other],
            { cwd: repository_root, allow_failure: true }
        );
        if (result.status === 0) {
            const candidate = result.stdout.trim();
            if (candidate) {
                return candidate;
            }
        }
    }

    return null;
}

function list_git_tree(repository_root: string, branch: string): string[] {
    // Empty-prefix case (single-source-at-repository-root): the whole branch
    // tree. Paths are already repository-relative.
    const result = run_git(
        ['ls-tree', '-r', '--name-only', branch],
        { cwd: repository_root, allow_failure: true }
    );
    if (result.status !== 0) {
        return [];
    }

    const accumulator = new Set<string>();
    for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
            accumulator.add(trimmed);
        }
    }

    return [...accumulator];
}

/**
 * List file paths tracked at the tip of `branch` under `source_prefix`,
 * returned relative to that prefix (NOT prepended with the prefix). The empty
 * `source_prefix` returns the full branch tree (relative to repository root).
 *
 * Per the multi-source-extraction spec, this is a per-source helper: callers
 * iterate `manifest.sources` and union the results, prepending each source's
 * `mount_name` to get container-workspace-relative paths for the overlay
 * exclusion set. Returns an empty array when the branch does not exist (the
 * `'missing'` case is the resume reachability pre-flight's responsibility to
 * surface).
 */
export function list_branch_files(
    repository_root: string,
    branch: string,
    source_prefix: string,
): string[] {
    if (!branch_exists(repository_root, branch)) {
        return [];
    }

    if (source_prefix === '') {
        return list_git_tree(repository_root, branch);
    }

    // `<branch>:<prefix>` is a tree-ish that resolves to the subtree at the
    // given path. `ls-tree -r --name-only` against that subtree emits
    // prefix-relative paths.
    const result = run_git(
        ['ls-tree', '-r', '--name-only', `${branch}:${source_prefix}`],
        { cwd: repository_root, allow_failure: true },
    );
    if (result.status !== 0) {
        return [];
    }

    const accumulator = new Set<string>();
    for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
            accumulator.add(trimmed);
        }
    }

    return [...accumulator];
}
