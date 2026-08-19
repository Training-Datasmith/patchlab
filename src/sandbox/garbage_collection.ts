import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { build_archive_path } from '../archive.js';
import { logger } from '../logger.js';
import {
    delete_patchlab_branch,
    delete_patchlab_branch_in_repositories,
    is_git_repository,
    patchlab_branch_name,
    patchlab_id_from_branch_name,
    unapplied_session_commits,
    PATCHLAB_BRANCH_PREFIX,
    type Delete_Branch_Outcome,
} from '../branch/index.js';
import {
    manifest_repositories,
    read_manifest,
    try_read_manifest_repository_roots,
    type Sandbox_Manifest,
} from '../manifest.js';
import {
    container_name_for,
    stop_and_remove_container_best_effort,
} from '../container_runtime.js';
import { stop_host_proxy } from '../local_model_proxy/manager.js';
import { list_sandboxes, type Sandbox_Info } from './inspect.js';

export interface Garbage_Collection_Options {
    /** Only destroy sandboxes older than this many days (default: 7). */
    older_than_days?: number;
    /** Also destroy sandboxes whose container is missing. */
    include_missing?: boolean;
    /** Preview what would be destroyed without actually doing it. */
    dry_run?: boolean;
    /**
     * When true, skip the per-orphan-branch unapplied-commit check and
     * force-delete every orphan branch encountered. Matches `patchlab destroy`'s
     * `--force` semantics, applied per orphan rather than per sandbox.
     */
    force?: boolean;
    /**
     * Per-orphan-branch confirmation hook for unapplied changes. Receives the
     * repository's `repository_root`, the orphan `patchlab/{id}` branch name,
     * and the count of unapplied session commits; returning `false` produces
     * `'skipped'` for that orphan. Returning `true` proceeds with force-delete.
     * In non-interactive mode (no hook supplied) without `force: true`, any
     * orphan with unapplied commits produces `'skipped'`.
     */
    confirm_orphan_branch_deletion?: (
        repository_root: string,
        branch: string,
        unapplied_count: number,
    ) => Promise<boolean> | boolean;
}

export type Orphan_Branch_Outcome = 'deleted' | 'skipped' | 'missing' | 'error';

export interface Garbage_Collection_Result {
    destroyed: Sandbox_Info[];
    skipped: Sandbox_Info[];
    /**
     * Per-repository per-orphan-branch outcomes from the orphan-branch scan.
     * Keys are the union of `repository_root` values across every tracked
     * patchlab (`manifest_repositories(manifest)` per patchlab, then deduped
     * in `readdir(~/.patchlab/)` ASCII-ascending × first-appearance order).
     * Inner keys are `patchlab/{id}` branch names. Values are `'deleted'`,
     * `'skipped'` (unapplied + no force), `'missing'` (the branch was already
     * gone when gc looked — confirmed by a post-delete `show-ref` probe), or
     * `'error'` (delete failed AND the branch is still present, e.g. it is
     * checked out in a worktree or git is holding a lock). Unreachable
     * repositories are SKIPPED with a warning and do NOT appear in this map.
     * Branches whose ID component contains characters rejected by
     * `assert_safe_patchlab_id` (e.g. a manually-created `patchlab/foo/bar`)
     * are warned about and ALSO do NOT appear in this map — gc cannot tell
     * a stale patchlab branch apart from an unrelated user branch under
     * `refs/heads/patchlab/`, so it leaves them alone.
     */
    orphan_outcomes: Record<string, Record<string, Orphan_Branch_Outcome>>;
}

function list_repositories(sandboxes: Sandbox_Info[]): Set<string> {
    const repositories_to_scan = new Set<string>();

    for (const sandbox of sandboxes) {
        try {
            const manifest = read_manifest(build_archive_path(sandbox.id));
            for (const repository_root of manifest_repositories(manifest)) {
                if (repository_root) {
                    repositories_to_scan.add(repository_root);
                }
            }
        } catch (_unreadable_manifest) {
            /* manifest unreadable */
        }
    }

    return repositories_to_scan;
}

/** Remove stale sandboxes based on age and container status. Also cleans up orphan patchlab branches. */
export async function garbage_collect_sandboxes(options?: Garbage_Collection_Options): Promise<Garbage_Collection_Result> {
    const older_than_days = options?.older_than_days ?? 7;
    const include_missing = options?.include_missing ?? true;
    const dry_run = options?.dry_run ?? false;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - older_than_days);

    const sandboxes = list_sandboxes();
    const destroyed: Sandbox_Info[] = [];
    const skipped: Sandbox_Info[] = [];

    // Capture the UNION of repositories across all tracked patchlabs BEFORE
    // the destroy loop. After destroy, the manifest is gone, so the orphan
    // scan couldn't otherwise discover the repositories. Multi-repository
    // patchlabs contribute every repository they span. Order matches spec
    // 5.2 / `GC cleans up orphaned branches`: `list_sandboxes` returns
    // `readdir(~/.patchlab/)` order; within each patchlab we iterate
    // `manifest_repositories(manifest)` in its first-appearance order; emit
    // each `repository_root` the first time it is encountered.
    const repositories_to_scan = list_repositories(sandboxes);

    for (const sandbox of sandboxes) {
        const created = new Date(sandbox.created_at);
        const old = created < cutoff;
        const missing = sandbox.container_status === 'missing';

        if (!(old || (include_missing && missing))) {
            skipped.push(sandbox);
            continue;
        }

        if (dry_run) {
            destroyed.push(sandbox);
            continue;
        }

        // Honor the SAME unapplied-commit protection the orphan path applies:
        // only force past it when the caller passed `force`. On a default
        // `patchlab gc` (no force), a stale patchlab whose session commits were
        // never applied to the host is SKIPPED — branch and archive preserved —
        // rather than silently destroyed on age alone. A declined/blocked
        // confirmation surfaces as a `'skipped'` branch outcome, which we map to
        // a gc skip here.
        const orphan_confirm = options?.confirm_orphan_branch_deletion;
        const result = await destroy_sandbox(sandbox.id, {
            force: options?.force,
            confirm: orphan_confirm
                ? (repository_root, unapplied_count) => orphan_confirm(
                    repository_root,
                    patchlab_branch_name(sandbox.id),
                    unapplied_count,
                )
                : undefined,
        });

        if (Object.values(result.branch_outcomes).includes('skipped') || !result.archive_removed) {
            skipped.push(sandbox);
        } else {
            destroyed.push(sandbox);
        }
    }

    // Orphan branch cleanup: scan each unique repository and remove
    // `patchlab/*` branches whose archive directory is missing. Uses the
    // repositories captured BEFORE destroy so even fully-emptied
    // repositories are still scanned.
    //
    // Limitation: dry_run does not preview orphan-branch cleanup — the
    // orphan_outcomes map is always empty in dry_run mode. Threading a
    // dry_run flag through `clean_up_orphan_branches` and into the per-branch
    // deletion logic is disproportionate scope for a low-value UX gap; the
    // sandbox-destruction preview (the `destroyed`/`skipped` arrays) is the
    // primary concern for callers of `--dry-run`.
    const orphan_outcomes: Record<string, Record<string, Orphan_Branch_Outcome>> = {};
    if (!dry_run) {
        await clean_up_orphan_branches(repositories_to_scan, orphan_outcomes, options);
    }

    return { destroyed, skipped, orphan_outcomes };
}

async function clean_up_orphan_branches(
    repositories: Set<string>,
    outcomes: Record<string, Record<string, Orphan_Branch_Outcome>>,
    options: Garbage_Collection_Options | undefined,
): Promise<void> {
    for (const repository_root of repositories) {
        if (!is_git_repository(repository_root)) {
            logger().warn(
                `patchlab gc: repository ${repository_root} is no longer a git repository; skipping orphan-branch scan. `
                + 'To clean up patchlab/* references that might remain on disk, manually re-create the repository or '
                + 'manually remove the stale archive directories under ~/.patchlab/.',
            );
            continue;
        }
        const per_repository: Record<string, Orphan_Branch_Outcome> = {};
        outcomes[repository_root] = per_repository;
        await clean_up_orphan_branches_in_one_repository(repository_root, per_repository, options);
    }
}

async function clean_up_orphan_branches_in_one_repository(
    repository_root: string,
    per_repository: Record<string, Orphan_Branch_Outcome>,
    options: Garbage_Collection_Options | undefined,
): Promise<void> {
    let branches: string[];
    try {
        branches = list_patchlab_branches(repository_root);
    } catch (_branch_listing_failed) {
        return;
    }
    for (const branch of branches) {
        const patchlab_id = patchlab_id_from_branch_name(branch);
        let archive_directory: string;
        try {
            // `build_archive_path` calls `assert_safe_patchlab_id`, which
            // throws on ids that escape the safe-character set (e.g. the
            // `foo/bar` extracted from a manually-created `patchlab/foo/bar`
            // branch). Patchlab itself never creates such branches, but a
            // single malformed one would otherwise abort the scan for this
            // whole repository. Warn and skip — it is not a patchlab
            // archive's orphan branch, so gc has nothing to clean up.
            archive_directory = build_archive_path(patchlab_id);
        } catch (_unsafe_patchlab_id) {
            logger().warn(
                `patchlab gc: branch ${branch} in ${repository_root} does not look like a patchlab branch `
                + '(id contains characters patchlab never produces); leaving it alone.',
            );
            continue;
        }

        if (fs.existsSync(archive_directory)) {
            continue;
        }

        per_repository[branch] = await decide_orphan_branch_outcome(
            repository_root,
            branch,
            patchlab_id,
            options,
        );
    }
}

/**
 * The unapplied-work gate for a single orphan branch. Returns `true` when the
 * branch must be left intact (`'skipped'`): a `--force`-less run with unapplied
 * commits and a declined/absent confirmation, OR a git failure that prevents
 * verifying applied-ness (fail closed). Returns `false` when deletion may
 * proceed. Mirrors `delete.ts`'s `unapplied_gate_skips` for the orphan path.
 */
async function orphan_unapplied_gate_skips(
    repository_root: string,
    branch: string,
    patchlab_id: string,
    options: Garbage_Collection_Options | undefined,
): Promise<boolean> {
    if (options?.force) {
        return false;
    }

    let unapplied: string[];
    try {
        unapplied = unapplied_session_commits(repository_root, patchlab_id, null);
    } catch (error) {
        // Fail closed: if we cannot verify applied-ness (a git failure on the
        // orphan branch), skip the deletion rather than risk discarding
        // unrecovered work.
        logger().warn(
            `patchlab gc: could not verify unapplied commits for orphan branch ${branch} in `
            + `${repository_root} (${error instanceof Error ? error.message : String(error)}); `
            + `skipping it.`
        );

        return true;
    }

    if (unapplied.length === 0) {
        return false;
    }
    const confirm = options?.confirm_orphan_branch_deletion;
    const proceed = confirm
        ? await confirm(repository_root, branch, unapplied.length)
        : false;

    return !proceed;
}

/**
 * Decide and execute the cleanup outcome for a single orphan `patchlab/{id}`
 * branch. The archive directory is already known to be missing.
 *
 * Per the spec's `GC cleans up orphaned branches` requirement, orphans are
 * "subject to the same per-repository unmerged check as `patchlab destroy`": with
 * unapplied commits, prompt via `confirm_orphan_branch_deletion` if supplied,
 * otherwise refuse in non-interactive mode unless `force` is true. Without
 * an archive there is no manifest, so the baseline commit is unknown and
 * passed as `null` — every commit on the orphan branch is treated as a
 * session commit for the unapplied check.
 */
async function decide_orphan_branch_outcome(
    repository_root: string,
    branch: string,
    patchlab_id: string,
    options: Garbage_Collection_Options | undefined,
): Promise<Orphan_Branch_Outcome> {
    if (await orphan_unapplied_gate_skips(repository_root, branch, patchlab_id, options)) {
        return 'skipped';
    }
    try {
        execFileSync('git', ['branch', '-D', branch], {
            cwd: repository_root,
            stdio: 'pipe',
        });
        return 'deleted';
    } catch (_branch_delete_failed) {
        // `git branch -D` failed. Probe to distinguish a real failure (branch
        // still present — checked out in a worktree, git lock held, etc.)
        // from a benign race (someone else already removed it). Without this
        // probe every failure looked like `'missing'`, hiding real problems
        // from the gc report.
        try {
            execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
                cwd: repository_root,
                stdio: 'pipe',
            });

            // show-ref succeeded → the ref is still there → delete really failed.
            logger().warn(
                `patchlab gc: could not delete orphan branch ${branch} in ${repository_root} `
                + '(branch is still present — possibly checked out in a worktree or git is holding a lock).',
            );
            return 'error';
        } catch (_ref_absent) {
            return 'missing';
        }
    }
}

function list_patchlab_branches(repository_root: string): string[] {
    try {
        const output = execFileSync(
            'git',
            ['for-each-ref', '--format=%(refname:short)', `refs/heads/${PATCHLAB_BRANCH_PREFIX}`],
            { cwd: repository_root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
        );
        return output.split('\n').map((line: string) => line.trim()).filter(Boolean);
    } catch (_for_each_ref_failed) {
        return [];
    }
}

export interface Destroy_Sandbox_Options {
    /** Skip the unapplied-commits check on the patchlab branch (every repository). */
    force?: boolean;
    /**
     * Per-repository confirmation hook for unapplied changes. Receives the
     * repository's `repository_root` and the count of unapplied session commits;
     * returning `false` skips that repository's branch (it is left intact). When
     * omitted in non-interactive mode, any repository with unapplied commits
     * produces a `'skipped'` outcome and blocks archive removal.
     */
    confirm?: (repository_root: string, unapplied_count: number) => Promise<boolean> | boolean;
}

export interface Destroy_Sandbox_Result {
    /**
     * Per-repository branch-cleanup outcomes from `delete_patchlab_branch`, keyed
     * on `manifest_repositories(manifest)` for the destroyed patchlab. Empty
     * when the manifest was unreadable and branch cleanup was not attempted.
     */
    branch_outcomes: Record<string, Delete_Branch_Outcome>;
    /**
     * Whether the archive directory at `~/.patchlab/{id}/` was removed. The
     * archive is removed ONLY when every repository's outcome is `'deleted'`,
     * `'missing'`, or `'error'`; any `'skipped'` outcome blocks removal so
     * the user can recover via subsequent operations.
     */
    archive_removed: boolean;
    /** True when `read_manifest` failed and destroy fell back to best-effort cleanup. */
    manifest_unreadable: boolean;
}

/**
 * Destroy a patchlab: stop container, remove it, delete `patchlab/{id}` in
 * EVERY repository the patchlab spans (per `manifest_repositories(manifest)`),
 * and remove the archive directory if every repository's branch outcome cleared.
 * Idempotent.
 *
 * Branch cleanup iterates the patchlab's repos via the underlying
 * `delete_patchlab_branch` helper, which produces the four-outcome per-repository
 * map (`'deleted'` | `'skipped'` | `'missing'` | `'error'`). When `force` is
 * supplied, every repository's branch is force-deleted regardless of unapplied
 * commits. When `confirm` is supplied without `force`, the confirmation
 * fires per repository with unapplied commits; a declined confirmation produces
 * `'skipped'` for that repository and blocks archive removal.
 *
 * The archive directory is removed at the end of destroy ONLY when every
 * repository's outcome is `'deleted'`, `'missing'`, or `'error'`. When ANY
 * repository's outcome is `'skipped'`, the archive directory remains so the
 * user can recover via subsequent operations (re-running destroy with `--force`,
 * or manual `git branch -D` followed by re-destroy).
 */
export async function destroy_sandbox(
    sandbox_id: string,
    options?: Destroy_Sandbox_Options
): Promise<Destroy_Sandbox_Result> {
    const sandbox_directory = build_archive_path(sandbox_id);
    const name = container_name_for(sandbox_id);

    // Capture the manifest before we touch anything — branch cleanup needs
    // `manifest_repositories(manifest)` to know which repositories to iterate.
    let manifest: Sandbox_Manifest | null = null;
    let manifest_unreadable = false;
    try {
        manifest = read_manifest(sandbox_directory);
        stop_host_proxy(sandbox_id);
        stop_and_remove_container_best_effort(manifest.container_name);
    } catch (_unreadable_manifest) {
        manifest_unreadable = true;
        // Manifest unreadable, try with derived name.
        stop_host_proxy(sandbox_id);
        stop_and_remove_container_best_effort(name);
    }

    let branch_outcomes: Record<string, Delete_Branch_Outcome> = {};
    let branch_cleanup_threw = false;
    let discovered_repository_roots: string[] = [];
    if (manifest !== null) {
        try {
            branch_outcomes = await delete_patchlab_branch(manifest, sandbox_id, {
                force: options?.force,
                confirm: options?.confirm,
            });
        } catch (error) {
            // Cleanup threw, so per-repository outcomes were never determined —
            // some branches may not have been examined at all. Do NOT remove the
            // archive (it carries the manifest/baseline metadata the branches
            // would otherwise be recoverable from); surface the failure rather
            // than swallowing it, per the logger-everything convention.
            branch_cleanup_threw = true;
            logger().warn(
                `Branch cleanup threw while destroying ${sandbox_id}; per-repository outcomes are `
                + `unknown, so the archive directory is being kept to avoid losing recoverable state. `
                + `${error instanceof Error ? error.message : String(error)}`
            );
        }
    } else {
        discovered_repository_roots = try_read_manifest_repository_roots(sandbox_directory);
        if (!options?.force) {
            logger().warn(
                `Manifest for ${sandbox_id} at ${sandbox_directory} is unreadable; `
                + `leaving the archive and patchlab branches intact. `
                + `Repair the manifest or re-run \`patchlab destroy ${sandbox_id} --force\` `
                + `to force-delete branches discovered from the corrupt file.`
            );
        } else if (discovered_repository_roots.length === 0) {
            logger().warn(
                `Manifest for ${sandbox_id} at ${sandbox_directory} is unreadable and no `
                + `repository roots could be recovered from it; leaving the archive and any `
                + `patchlab branches intact. Repair the manifest or delete branches manually.`
            );
        } else {
            try {
                branch_outcomes = await delete_patchlab_branch_in_repositories(
                    sandbox_id,
                    discovered_repository_roots,
                    {
                        force: options.force,
                        confirm: options?.confirm,
                    },
                );
            } catch (error) {
                branch_cleanup_threw = true;
                logger().warn(
                    `Branch cleanup threw while destroying ${sandbox_id} from recovered repository roots; `
                    + `per-repository outcomes are unknown, so the archive directory is being kept. `
                    + `${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
    }

    // Archive removal is conditional on every repository's outcome being
    // 'deleted', 'missing', or 'error'. Any 'skipped' outcome — or a cleanup
    // that threw before outcomes could be determined — blocks removal so the
    // user can recover. When the manifest was unreadable, archive removal is
    // also blocked unless `--force` supplied repository roots to clean up.
    const any_skipped = Object.values(branch_outcomes).includes('skipped');
    const may_remove_archive_after_unreadable_manifest =
        !manifest_unreadable || (options?.force === true && discovered_repository_roots.length > 0);
    let archive_removed = false;
    if (
        may_remove_archive_after_unreadable_manifest
        && !branch_cleanup_threw
        && !any_skipped
        && fs.existsSync(sandbox_directory)
    ) {
        fs.rmSync(sandbox_directory, { recursive: true, force: true });
        archive_removed = true;
    }

    return { branch_outcomes, archive_removed, manifest_unreadable };
}
