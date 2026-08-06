/**
 * Branch creation at patchlab-creation time.
 *
 * `create_patchlab_branch` is the public Phase 2 entry: opens a fresh
 * `patchlab/{id}` branch at the repository's HEAD and, when the working tree
 * is dirty, captures it as a labeled baseline commit on that branch WITHOUT
 * touching the user's index or working tree.
 *
 * The baseline-commit machinery (`create_baseline_commit`, `with_index_env`,
 * `commit_tree_with_parent`) operates against a temporary index file so the
 * user's `.git/index` stays untouched. `make_temporary_index_path` is exported
 * because the session-commit fan-out also needs the same uniqueness scheme
 * to allocate its own per-repository index files.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { assert_safe_patchlab_id } from '../archive.js';
import { logger } from '../logger.js';
import { safe_unlink } from '../safe_filesystem.js';
import { run_git, rev_parse } from './internals.js';
import { patchlab_branch_name } from './naming.js';
import { patchlab_branch_exists } from './predicates.js';

export interface Create_Branch_Options {
    /** When true, capture the dirty working tree as a baseline commit on the new branch. */
    capture_dirty_baseline?: boolean;
    /** Commit message author/committer details for any baseline commit. */
    author_name?: string;
    author_email?: string;
}

/**
 * Result of creating one repository's patchlab branch in Phase 2 of the multi-repository
 * branch-creation flow (`Branch creation at patchlab creation`). Used by the
 * caller to populate the manifest's per-repository `baseline_commit_shas` and
 * `branch_creation_point_shas` maps.
 */
export interface Create_Branch_Result {
    branch_name: string;
    /** Host repository's HEAD SHA at branch-creation time — the start of the cumulative-diff range. */
    branch_creation_point_sha: string;
    /** SHA of the baseline commit if one was created, null otherwise. */
    baseline_sha: string | null;
}

/**
 * Create a `patchlab/{id}` branch in `repository_root` at HEAD. If
 * `capture_dirty_baseline` is true and the working tree is dirty, also creates
 * a labeled baseline commit on the branch capturing the uncommitted changes
 * (tracked + untracked, excluding gitignored — matching `git add -A` semantics).
 *
 * Per `multi-source-lifecycle` Task 2.6 the function accepts `repository_root`
 * explicitly (replacing the legacy `source_path` parameter that derived the
 * repository root internally). Callers in the create flow's Phase 2 supply the
 * per-repository `repository_root` from the loop variable over
 * `manifest_repositories(manifest)`.
 *
 * Does NOT modify the user's working tree, index, or current branch.
 * Returns the resulting branch's creation-point SHA and the baseline commit
 * SHA (or null). The caller folds these into the manifest's per-repository maps.
 */
export function create_patchlab_branch(
    repository_root: string,
    patchlab_id: string,
    options?: Create_Branch_Options
): Create_Branch_Result {
    const branch = patchlab_branch_name(patchlab_id);

    if (patchlab_branch_exists(repository_root, patchlab_id)) {
        throw new Error(
            `Branch ${branch} already exists in ${repository_root}. ` +
            `Each patchlab requires a unique branch name.`
        );
    }

    let head_sha: string;
    try {
        head_sha = rev_parse(repository_root, 'HEAD');
    } catch (_no_head_commit) {
        throw new Error(
            `Repository at ${repository_root} has no commits.`
          + '  Patchlab requires at least one commit on the host repository'
          + ' so the patchlab branch has a baseline.'
          + '  Run `git commit --allow-empty -m initial` to create one.'
        );
    }
    run_git(['branch', branch, head_sha], { cwd: repository_root });

    if (!options?.capture_dirty_baseline) {
        return {
            branch_name: branch,
            branch_creation_point_sha: head_sha,
            baseline_sha: null,
        };
    }

    let baseline_sha: string | null;
    try {
        baseline_sha = create_baseline_commit(repository_root, branch, head_sha, {
            author_name: options.author_name,
            author_email: options.author_email,
            patchlab_id,
        });
    } catch (error) {
        // The branch ref now exists but the baseline commit failed (locked
        // index, EACCES during `git add`, disk full). Roll the branch back so a
        // retry starts clean instead of tripping over a half-built
        // `patchlab/{id}` ref. Best-effort: warn if the rollback itself fails.
        try {
            run_git(['branch', '-D', branch], { cwd: repository_root });
        } catch (cleanup_error) {
            logger().warn(
                `Failed to remove the partially-created branch ${branch} in ${repository_root} `
                + `after baseline-commit creation failed: `
                + `${cleanup_error instanceof Error ? cleanup_error.message : String(cleanup_error)}.`
            );
        }

        throw error;
    }

    return {
        branch_name: branch,
        branch_creation_point_sha: head_sha,
        baseline_sha,
    };
}

interface Baseline_Author {
    author_name?: string;
    author_email?: string;
    patchlab_id: string;
}

/**
 * Build a baseline commit from the working tree without touching the user's index.
 * Returns the new commit SHA, or null if the working tree was clean (no commit needed).
 */
function create_baseline_commit(
    repository_root: string,
    branch: string,
    parent_sha: string,
    info: Baseline_Author
): string | null {
    const temporary_index = make_temporary_index_path(info.patchlab_id, 'baseline');
    try {
        // Initialize temporary index from parent commit.
        run_git(['read-tree', parent_sha], { cwd: repository_root, env: with_index_env(temporary_index) });

        // Stage all working-tree changes (tracked + untracked, excluding gitignored).
        // No `--force`: baseline must respect `.gitignore`, matching `git add -A` semantics
        // declared in the spec.
        run_git(['add', '-A', '--'], { cwd: repository_root, env: with_index_env(temporary_index) });

        const tree = run_git(['write-tree'], { cwd: repository_root, env: with_index_env(temporary_index) }).stdout.trim();

        const parent_tree = run_git(['rev-parse', `${parent_sha}^{tree}`], { cwd: repository_root }).stdout.trim();
        if (tree === parent_tree) {
            // Working tree matches HEAD; nothing to commit.
            return null;
        }

        const message = `Uncommitted host changes — patchlab ${info.patchlab_id}`;
        const commit_sha = commit_tree_with_parent(
            repository_root,
            tree,
            [parent_sha],
            message,
            info.author_name,
            info.author_email
        );

        run_git(['update-ref', `refs/heads/${branch}`, commit_sha], { cwd: repository_root });
        return commit_sha;
    } finally {
        safe_unlink(temporary_index);
    }
}

/**
 * Set GIT_INDEX_FILE in env. Exported because the session-commit fan-out
 * (session_commit.ts) also runs git against a temporary index file for the
 * same reason — keeping the user's `.git/index` untouched.
 */
export function with_index_env(temporary_index: string): NodeJS.ProcessEnv {
    return { ...process.env, GIT_INDEX_FILE: temporary_index };
}

/** Allocate a unique temporary index path. Concurrent extractions never collide. */
export function make_temporary_index_path(patchlab_id: string, label: string): string {
    assert_safe_patchlab_id(patchlab_id);
    return path.join(
        os.tmpdir(),
        `patchlab-${patchlab_id}-${label}-${crypto.randomUUID().slice(0, 8)}.idx`
    );
}

/** Run `git commit-tree` with one or more parents and return the new commit SHA. */
export function commit_tree_with_parent(
    repository_root: string,
    tree: string,
    parents: string[],
    message: string,
    author_name?: string,
    author_email?: string
): string {
    const commit_tree_arguments = ['commit-tree', tree];
    for (const parent of parents) {
        commit_tree_arguments.push('-p', parent);
    }
    commit_tree_arguments.push('-m', message);

    const environment: NodeJS.ProcessEnv = { ...process.env };
    if (author_name) {
        environment.GIT_AUTHOR_NAME = author_name;
        environment.GIT_COMMITTER_NAME = author_name;
    }
    if (author_email) {
        environment.GIT_AUTHOR_EMAIL = author_email;
        environment.GIT_COMMITTER_EMAIL = author_email;
    }

    return run_git(commit_tree_arguments, { cwd: repository_root, env: environment }).stdout.trim();
}
