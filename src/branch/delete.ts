/**
 * Patchlab-branch deletion (destroy path) and the unapplied-commits detector
 * that gates it.
 *
 * `delete_patchlab_branch` is the public destroy orchestrator: it iterates
 * `manifest_repositories(manifest)` and per repository either force-deletes,
 * skips (unapplied + no force), reports missing (idempotent re-destroy), or
 * errors (unreachable repository). Outcomes are surfaced verbatim so the
 * caller can decide whether to remove the archive.
 *
 * `unapplied_session_commits` is the cherry-pick comparison the destroy path
 * runs to decide between `'deleted'` and `'skipped'`. It's also called from
 * the GC orphan-branch scan ([src/sandbox/garbage_collection.ts](../sandbox/garbage_collection.ts))
 * so it's exported alongside its parsers — these are the destroy path's
 * exclusive predicate AND its only out-of-file consumer is the orphan
 * scan, so grouping them here keeps the "destroy decides via cherry" logic
 * in one place.
 */
import * as fs from 'node:fs';
import { get_repository_root } from '../archive.js';
import { logger } from '../logger.js';
import {
    manifest_repositories,
    type Sandbox_Manifest,
} from '../manifest.js';
import { run_git, list_other_local_branches } from './internals.js';
import { patchlab_branch_name } from './naming.js';
import { patchlab_branch_exists } from './predicates.js';

/**
 * Detect whether a session commit on the patchlab branch has been applied
 * to any other branch (using `git cherry`, which compares by patch ID rather
 * than by SHA — this correctly handles cherry-picked commits with different SHAs).
 *
 * Returns the list of session-commit SHAs that are NOT applied anywhere else.
 * The baseline commit (if any) is excluded from the check.
 */
export function unapplied_session_commits(
    repository_root: string,
    patchlab_id: string,
    baseline_commit_sha: string | null
): string[] {
    const branch = patchlab_branch_name(patchlab_id);
    if (!patchlab_branch_exists(repository_root, patchlab_id)) {
        return [];
    }

    // Enumerate the branch's FULL commit list (oldest-first). This is not yet
    // "commits exclusive to the branch" — it is the raw history, used only as
    // the fallback when the cherry/patch-id intersection below cannot be
    // computed. The exclusivity filtering happens in
    // `compute_unapplied_intersection`.
    const log_result = run_git(
        ['log', '--reverse', '--format=%H', branch],
        { cwd: repository_root, allow_failure: true }
    );
    if (log_result.status !== 0) {
        // Fail CLOSED. The branch was just confirmed to exist (line above), so a
        // non-zero `git log` is an unexpected failure (corrupt loose object,
        // ENOBUFS, …), not "no commits". Returning `[]` here would read as
        // "nothing unapplied" and let the caller force-delete the branch — the
        // user's only copy of the session work — without prompting. Throw so the
        // caller treats "cannot determine" as "do not delete".
        throw new Error(
            `Cannot enumerate commits on ${branch} in ${repository_root}: git log exited `
            + `${log_result.status}. Refusing to treat this as "no unapplied commits".`
            + (log_result.stderr ? ` git stderr: ${log_result.stderr.trim()}` : '')
        );
    }

    // The branch creation point (HEAD at create time) is implied to be reachable from another branch.
    // Filter out commits that are also reachable from any other local branch via patch-id.
    // We approximate this by running `git cherry <other> <branch>` for each other local branch and
    // intersecting the "+" (unapplied) results.
    const other_branches = list_other_local_branches(repository_root, branch);
    const unapplied = compute_unapplied_intersection(repository_root, branch, other_branches)
        ?? parse_branch_commit_list(log_result.stdout);

    if (baseline_commit_sha) {
        unapplied.delete(baseline_commit_sha);
    }

    return [...unapplied];
}

/**
 * Run `git cherry` against each other local branch and intersect the results — a session
 * commit counts as unapplied only when no other branch already carries it (by patch id).
 *
 * Returns null when no other branches exist (or every comparison failed), signaling that
 * the caller should fall back to "every commit on the branch is unapplied".
 */
function compute_unapplied_intersection(
    repository_root: string,
    branch: string,
    other_branches: string[]
): Set<string> | null {
    let intersection: Set<string> | null = null;

    for (const other of other_branches) {
        const cherry = run_git(['cherry', other, branch], { cwd: repository_root, allow_failure: true });
        if (cherry.status !== 0) {
            continue;
        }

        const this_unapplied = parse_unapplied_shas(cherry.stdout);
        intersection = intersection === null
            ? this_unapplied
            : new Set((Array.from(intersection) as string[]).filter(
                (sha: string) => this_unapplied.has(sha)));
    }

    return intersection;
}

/** Parse `+` lines from `git cherry` output into a set of unapplied commit SHAs. */
function parse_unapplied_shas(cherry_output: string): Set<string> {
    const unapplied = new Set<string>();
    for (const line of cherry_output.split('\n')) {
        const match = /^\+\s+([0-9a-f]+)/.exec(line);
        if (match) {
            unapplied.add(match[1]);
        }
    }
    return unapplied;
}

/** Parse `git log --format=%H` output into a set of commit SHAs. */
function parse_branch_commit_list(log_output: string): Set<string> {
    const commits = new Set<string>();
    for (const line of log_output.split('\n')) {
        const sha = line.trim();
        if (sha) {
            commits.add(sha);
        }
    }
    return commits;
}

export type Delete_Branch_Outcome = 'deleted' | 'skipped' | 'missing' | 'error';

export interface Delete_Branch_Options {
    /** When true, force-delete without consulting the unapplied check, in every repository. */
    force?: boolean;
    /**
     * Per-repository confirmation hook for unapplied changes. Receives the repository's
     * `repository_root` and the count of unapplied session commits; returning
     * `false` produces `'skipped'` for that repository. Returning `true` proceeds
     * with force-delete. In non-interactive mode (no hook supplied) without
     * `--force`, any repository with unapplied commits produces `'skipped'`.
     */
    confirm?: (repository_root: string, unapplied_count: number) => Promise<boolean> | boolean;
}

/**
 * Delete the `patchlab/{id}` branch in EVERY repository the patchlab spans,
 * per `manifest_repositories(manifest)`. Returns a per-repository outcome map whose
 * keyset exactly equals `manifest_repositories(manifest)`. Outcomes per spec:
 *
 * - `'deleted'`: the branch was force-deleted (force or confirmation cleared
 *   the unapplied check).
 * - `'missing'`: the repository is still a git repository but no `patchlab/{id}` branch
 *   exists (idempotent re-destroy case). Counts as success for archive removal.
 * - `'skipped'`: the branch has unapplied session commits AND the
 *   confirmation declined (or non-interactive without `--force`). The branch
 *   is not touched. Blocks archive removal.
 * - `'error'`: the repository's `repository_root` is no longer a git repository at
 *   destroy time. The system surfaces a warning naming the unreachable repository.
 *   Counts as success for archive removal because the patchlab cannot
 *   meaningfully retain its archive when a repository is irrecoverable.
 *
 * Per-repository iteration runs in `manifest_repositories(manifest)`'s deterministic
 * order. The `confirm` callback fires once per repository with unapplied commits
 * when `force` is `false`.
 *
 * Idempotent per repository — re-running against the same manifest after a partial
 * destroy proceeds against any `'skipped'` repos and surfaces `'missing'`
 * for any that were already deleted.
 */
export async function delete_patchlab_branch(
    manifest: Sandbox_Manifest,
    patchlab_id: string,
    options?: Delete_Branch_Options
): Promise<Record<string, Delete_Branch_Outcome>> {
    const outcomes: Record<string, Delete_Branch_Outcome> = {};
    const branch = patchlab_branch_name(patchlab_id);
    const repositories = manifest_repositories(manifest);

    for (const repository_root of repositories) {
        try {
            outcomes[repository_root] = await delete_branch_in_one_repository(
                manifest,
                patchlab_id,
                repository_root,
                branch,
                options,
            );
        } catch (error) {
            // One repository's failure (e.g. `git branch -D` refusing because the
            // branch is checked out in a linked worktree) must not abort the
            // whole fan-out and discard the outcomes already gathered. Record it
            // as `'skipped'` — the branch was NOT deleted and very likely still
            // exists, so this MUST block archive removal (an `'error'` outcome
            // would wrongly authorize it) — and continue with the next repository.
            logger().warn(
                `Branch deletion failed in ${repository_root}: `
                + `${error instanceof Error ? error.message : String(error)}. `
                + `Leaving its branch in place and continuing with the remaining repositories.`
            );
            outcomes[repository_root] = 'skipped';
        }
    }

    return outcomes;
}

async function delete_branch_in_one_repository(
    manifest: Sandbox_Manifest,
    patchlab_id: string,
    repository_root: string,
    branch: string,
    options: Delete_Branch_Options | undefined,
): Promise<Delete_Branch_Outcome> {
    // Repo reachability: the path must still be a git repository at destroy
    // time. Per the spec's `Branch cleanup on destroy` requirement, a
    // non-git path yields the `'error'` outcome (counts as success for
    // archive removal — the patchlab cannot retain its archive when a repository
    // is irrecoverable).
    let valid = false;
    try {
        if (fs.existsSync(repository_root)) {
            get_repository_root(repository_root);
            valid = true;
        }
    } catch (_not_a_git_repository) {
        valid = false;
    }
    if (!valid) {
        return 'error';
    }

    // Branch-existence check FIRST: a missing branch in a still-reachable
    // repository is the idempotent-destroy case ('missing'). The unapplied-commit
    // check (`git cherry`) is SKIPPED when the branch doesn't exist.
    if (!patchlab_branch_exists(repository_root, patchlab_id)) {
        return 'missing';
    }

    if (await unapplied_gate_skips(manifest, patchlab_id, repository_root, options)) {
        return 'skipped';
    }

    run_git(['branch', '-D', branch], { cwd: repository_root });
    return 'deleted';
}

/**
 * The unapplied-work gate for a single repository's branch deletion. Returns
 * `true` when the branch must be left intact (`'skipped'`): a `--force`-less
 * run with unapplied session commits and either a declined confirmation or no
 * confirmation hook, OR a git failure that prevents verifying applied-ness
 * (fail closed). Returns `false` when deletion may proceed.
 */
async function unapplied_gate_skips(
    manifest: Sandbox_Manifest,
    patchlab_id: string,
    repository_root: string,
    options: Delete_Branch_Options | undefined,
): Promise<boolean> {
    const baseline = manifest.baseline_commit_shas[repository_root] ?? null;
    return unapplied_gate_skips_with_baseline(patchlab_id, repository_root, baseline, options);
}

async function unapplied_gate_skips_with_baseline(
    patchlab_id: string,
    repository_root: string,
    baseline_commit_sha: string | null,
    options: Delete_Branch_Options | undefined,
): Promise<boolean> {
    if (options?.force) {
        return false;
    }

    let unapplied: string[];
    try {
        unapplied = unapplied_session_commits(repository_root, patchlab_id, baseline_commit_sha);
    } catch (error) {
        // Fail closed: a git failure means we cannot prove the session work is
        // applied elsewhere, so refuse to delete rather than risk destroying the
        // only copy. Surface the reason and skip this repository.
        logger().warn(
            `Skipping branch deletion in ${repository_root}: could not verify unapplied `
            + `session commits (${error instanceof Error ? error.message : String(error)}).`
        );

        return true;
    }

    if (unapplied.length === 0) {
        return false;
    }
    if (options?.confirm) {
        const proceed = await options.confirm(repository_root, unapplied.length);
        return !proceed;
    }

    // Non-interactive without --force: refuse to delete unapplied work.
    return true;
}

/**
 * Delete `patchlab/{id}` in an explicit repository list without a readable
 * manifest. Baseline SHAs are unknown, so every commit on the branch is
 * treated as a session commit for the unapplied check — the same semantics
 * the GC orphan-branch path uses.
 */
export async function delete_patchlab_branch_in_repositories(
    patchlab_id: string,
    repository_roots: readonly string[],
    options?: Delete_Branch_Options,
): Promise<Record<string, Delete_Branch_Outcome>> {
    const outcomes: Record<string, Delete_Branch_Outcome> = {};
    const branch = patchlab_branch_name(patchlab_id);

    for (const repository_root of repository_roots) {
        try {
            outcomes[repository_root] = await delete_branch_in_one_repository_without_manifest(
                patchlab_id,
                repository_root,
                branch,
                options,
            );
        } catch (error) {
            logger().warn(
                `Branch deletion failed in ${repository_root}: `
                + `${error instanceof Error ? error.message : String(error)}. `
                + `Leaving its branch in place and continuing with the remaining repositories.`
            );
            outcomes[repository_root] = 'skipped';
        }
    }

    return outcomes;
}

async function delete_branch_in_one_repository_without_manifest(
    patchlab_id: string,
    repository_root: string,
    branch: string,
    options: Delete_Branch_Options | undefined,
): Promise<Delete_Branch_Outcome> {
    let valid = false;
    try {
        if (fs.existsSync(repository_root)) {
            get_repository_root(repository_root);
            valid = true;
        }
    } catch (_not_a_git_repository) {
        valid = false;
    }
    if (!valid) {
        return 'error';
    }

    if (!patchlab_branch_exists(repository_root, patchlab_id)) {
        return 'missing';
    }

    if (await unapplied_gate_skips_with_baseline(patchlab_id, repository_root, null, options)) {
        return 'skipped';
    }

    run_git(['branch', '-D', branch], { cwd: repository_root });
    return 'deleted';
}
