/**
 * Two-phase host-branch handshake for `create_sandbox`. The handshake walks
 * every distinct host repository the patchlab will span:
 *
 *   - **Phase 1 (`execute_phase_1_preflight`)** — five pre-flight checks per
 *     repository (is-git, no-submodules, dirty-tree, branch-absent, trust).
 *     Mutates NOTHING; on failure, no host repository state has changed.
 *   - **Phase 2 (`execute_phase_2_mutations`)** — creates one `patchlab/{id}`
 *     branch per repository and (for dirty repos) captures a baseline commit.
 *     `rollback_phase_2_created_branches` force-deletes the partial set if a
 *     later repository's mutation throws.
 *
 * Two source-list helpers (`validate_source_paths`,
 * `collect_unique_repositories`) live here because their output feeds Phase 1
 * directly and they have no callers outside the create path.
 *
 * Extracted from `src/sandbox/provisioning.ts` (cluster 2 of the 2370-line file). All
 * functions are pure over their arguments — no module-level state.
 *
 * Tests: [test/unit/branch.test.ts](../../test/unit/branch.test.ts) imports
 * the three exported phase functions via `src/sandbox/index.ts`'s re-export.
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
    create_patchlab_branch,
    detect_submodules,
    is_git_repository,
    is_working_tree_dirty,
    patchlab_branch_exists,
    patchlab_branch_name,
} from '../branch/index.js';
import type { Source_Specification } from '../manifest.js';
import type { Prompter } from '../prompts.js';
import { logger } from '../logger.js';

/**
 * Narrow option slot accepted by `execute_phase_1_preflight`. The full
 * `Create_Sandbox_Options` interface defined in `src/sandbox/provisioning.ts` satisfies
 * this structurally, so callers can pass it directly without conversion.
 */
export interface Phase_1_Options {
    allow_submodules?: boolean;
    allow_dirty_tree?: boolean;
    prompter?: Prompter | null;
}

/**
 * Phase 1 of multi-repository branch creation: pre-flight checks against every
 * distinct host repository the patchlab will span, before any host-repository
 * mutation. Per the `patchlab-branch` capability's `Branch creation at
 * patchlab creation` requirement, Phase 1 runs four sub-steps per repository in
 * the deterministic order over `manifest_repositories(manifest)`:
 *
 *   (a) `assert_is_git_repository` validation
 *   (b) submodule detection + in-place confirmation via `prompter`
 *   (c) dirty-tree detection + in-place confirmation via `prompter`
 *   (d) `patchlab/{id}` branch-existence check
 *
 * Dirty-tree and submodule confirmations fire at most once per condition type
 * across all repositories: once the first dirty-tree is confirmed, subsequent
 * dirty repos in the same call proceed without re-prompting. The same applies
 * to submodule confirmations. When `prompter` is null (non-interactive),
 * undecided conditions throw immediately (same behavior as before).
 *
 * Each sub-step short-circuits the per-repository iteration on failure:
 * subsequent repositories are NOT evaluated. Phase 1 mutates NOTHING on any
 * host git repository. The returned `dirty_repositories` set tells Phase 2
 * which repositories need baseline commits.
 */
export async function execute_phase_1_preflight(
    repositories: string[],
    patchlab_id: string,
    options: Phase_1_Options | undefined,
): Promise<Set<string>> {
    const dirty_repositories = new Set<string>();
    const prompter = options?.prompter ?? null;
    let allow_dirty_tree_this_call = options?.allow_dirty_tree;
    let allow_submodules_this_call = options?.allow_submodules;

    for (const repository_root of repositories) {
        assert_repository_is_git(repository_root);
        allow_submodules_this_call = await check_submodule_gate(repository_root, allow_submodules_this_call, prompter);
        allow_dirty_tree_this_call = await check_dirty_tree_gate(repository_root, allow_dirty_tree_this_call, dirty_repositories, prompter);
        assert_patchlab_branch_absent(repository_root, patchlab_id);
    }

    return dirty_repositories;
}

/**
 * Sub-step (b) of Phase 1: submodule gate. Returns the updated
 * `allow_submodules` value (`true` once confirmed, unchanged otherwise).
 * Confirming once covers all repositories in the call — the caller passes
 * the return value as the flag for subsequent repositories. Throws when
 * submodules are found and the caller passed `false` or when `prompter` is
 * null (non-interactive context).
 */
async function check_submodule_gate(
    repository_root: string,
    allow_submodules: boolean | undefined,
    prompter: Prompter | null,
): Promise<boolean | undefined> {
    if (allow_submodules === true) {
        return true;
    }
    const submodules = detect_submodules(repository_root);
    if (submodules.length === 0) {
        return allow_submodules;
    }

    if (allow_submodules === false || prompter === null) {
        throw new Error(
            `Repository ${repository_root} contains git submodules: ${submodules.join(', ')}. `
            + `Submodules are not supported and may cause apply failures. `
            + `Pass allow_submodules: true to proceed (submodule contents will be treated as regular files).`,
        );
    }

    logger().warn(
        `Repository ${repository_root} contains git submodules: ${submodules.join(', ')}. `
        + `Submodules are not supported and may cause apply failures.`,
    );

    const proceed = await prompter.confirm('Proceed anyway? [y/N] ');
    if (!proceed) {
        throw new Error(
            `Repository ${repository_root} contains git submodules: ${submodules.join(', ')}. `
            + `Submodules are not supported and may cause apply failures. `
            + `Pass allow_submodules: true to proceed (submodule contents will be treated as regular files).`,
        );
    }

    return true;
}

/**
 * Sub-step (c) of Phase 1: dirty-tree gate. Returns the updated
 * `allow_dirty_tree` value (`true` once confirmed, unchanged otherwise) and
 * records dirty repositories in `dirty_repositories` for Phase 2. Confirming
 * once covers all repositories in the call — the caller passes the return value
 * as the flag for subsequent repositories. Throws when the tree is dirty and
 * `prompter` is null (non-interactive context).
 */
async function check_dirty_tree_gate(
    repository_root: string,
    allow_dirty_tree: boolean | undefined,
    dirty_repositories: Set<string>,
    prompter: Prompter | null,
): Promise<boolean | undefined> {
    if (allow_dirty_tree !== undefined) {
        if (check_dirty_tree_and_record(repository_root, allow_dirty_tree)) {
            dirty_repositories.add(repository_root);
        }
        return allow_dirty_tree;
    }

    if (!is_working_tree_dirty(repository_root)) {
        return undefined;
    }

    if (prompter === null) {
        throw new Error(
            `Host working tree at ${repository_root} has uncommitted changes.`
            + `  These will be captured as a labeled baseline commit`
            + ` on the patchlab branch in ${repository_root} if you proceed.`
            + `  Pass allow_dirty_tree: true to proceed,`
            + ` or commit/stash your changes first.`,
        );
    }

    logger().warn(
        `Host working tree at ${repository_root} has uncommitted changes. `
        + `These will be captured as a labeled baseline commit on the patchlab branch.`,
    );

    const proceed = await prompter.confirm(
        'Proceed and capture the dirty state as a baseline commit on the patchlab branch? [y/N] ',
    );
    if (!proceed) {
        throw new Error(
            `Host working tree at ${repository_root} has uncommitted changes.`
            + `  These will be captured as a labeled baseline commit`
            + ` on the patchlab branch in ${repository_root} if you proceed.`
            + `  Pass allow_dirty_tree: true to proceed,`
            + ` or commit/stash your changes first.`,
        );
    }

    dirty_repositories.add(repository_root);
    return true;
}

/**
 * Sub-step (a) of Phase 1: is-git-repository check. Defensive depth —
 * `resolve_source_inputs` already ran `git rev-parse --show-toplevel` per
 * source, but a repository path could be tampered with between resolution
 * and create.
 */
function assert_repository_is_git(repository_root: string): void {
    if (!is_git_repository(repository_root)) {
        throw new Error(
            `Repository ${repository_root} is not a git repository (or no longer reachable). `
            + `Cannot create a patchlab branch in a non-git location.`,
        );
    }
}

/**
 * Sub-step (c) of Phase 1: dirty-tree detection + user confirmation. Returns
 * `true` when the working tree is dirty AND the caller opted in via
 * `allow_dirty_tree: true` (so the caller's outer loop records this repository
 * as needing a baseline commit in Phase 2). Throws when the working tree is
 * dirty but the caller passed `false` or did not pass the flag.
 */
function check_dirty_tree_and_record(repository_root: string, allow_dirty_tree: boolean | undefined): boolean {
    if (!is_working_tree_dirty(repository_root)) {
        return false;
    }

    if (allow_dirty_tree === false) {
        throw new Error(
            `Host working tree at ${repository_root} has uncommitted changes. `
            + `Aborting per allow_dirty_tree: false.`,
        );
    }

    if (allow_dirty_tree === undefined) {
        throw new Error(
            `Host working tree at ${repository_root} has uncommitted changes.`
          + '  These will be captured as a labeled baseline commit'
          + ` on the patchlab branch in ${repository_root} if you proceed.`
          + '  Pass allow_dirty_tree: true to proceed,'
          + ' or commit/stash your changes first.',
        );
    }

    return true;
}

/** Sub-step (d) of Phase 1: `patchlab/{id}` branch existence check. */
function assert_patchlab_branch_absent(repository_root: string, patchlab_id: string): void {
    if (patchlab_branch_exists(repository_root, patchlab_id)) {
        const branch = patchlab_branch_name(patchlab_id);
        throw new Error(
            `Branch ${branch} already exists in ${repository_root}. `
            + 'Each patchlab requires a unique branch name across'
            + ' every repository it spans.',
        );
    }
}

/**
 * Phase 2 of multi-repository branch creation: mutations that produce one
 * `patchlab/{id}` branch per repository AND capture per-repository baseline commits
 * for the repos identified as dirty in Phase 1. Tracks each successfully-
 * created branch in `created_branch_repositories` so the caller can roll back via
 * force-delete if any per-repository step throws.
 *
 * The returned in-memory SHA maps are committed to disk by `write_manifest`
 * exactly once — at the END of Phase 2 — by the create-sandbox caller. If
 * any per-repository step throws, the caller's rollback path discards the maps
 * entirely (no partial state persists) AND force-deletes every tracked
 * branch.
 */
export function execute_phase_2_mutations(
    repositories: string[],
    patchlab_id: string,
    dirty_repositories: Set<string>,
    created_branch_repositories: string[],
): { baseline_commit_shas: Record<string, string | null>; branch_creation_point_shas: Record<string, string | null> } {
    const baseline_commit_shas: Record<string, string | null> = {};
    const branch_creation_point_shas: Record<string, string | null> = {};
    for (const repository_root of repositories) {
        const dirty = dirty_repositories.has(repository_root);
        const result = create_patchlab_branch(repository_root, patchlab_id, {
            capture_dirty_baseline: dirty,
            author_name: 'patchlab',
            author_email: 'patchlab@local',
        });
        created_branch_repositories.push(repository_root);
        baseline_commit_shas[repository_root] = result.baseline_sha;
        branch_creation_point_shas[repository_root] = result.branch_creation_point_sha;
    }

    return { baseline_commit_shas, branch_creation_point_shas };
}

/**
 * Phase 2 rollback: force-delete every branch tracked in `created_branch_repositories`.
 * These branches carry no session commits yet (they were just created in this
 * invocation), so force-delete is safe. A per-repository delete failure is
 * warned (so the operator can remove the leftover branch by hand) but does NOT
 * propagate — the caller is already throwing the original Phase 2 failure, and
 * the rollback warning goes to stderr alongside it rather than replacing it.
 */
export function rollback_phase_2_created_branches(
    created_branch_repositories: string[],
    patchlab_id: string,
): void {
    const branch = patchlab_branch_name(patchlab_id);
    for (const repository_root of created_branch_repositories) {
        try {
            execFileSync('git', ['branch', '-D', branch], {
                cwd: repository_root,
                stdio: 'pipe',
            });
        } catch (error) {
            // Best-effort cleanup. Surface the failure so a leftover branch is
            // visible; this is additive to (not a replacement for) the original
            // Phase 2 error the caller is already throwing.
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(
                `Rollback: could not delete branch ${branch} in ${repository_root} after a Phase 2 `
                + `failure — remove it manually if it persists. ${message}`,
            );
        }
    }
}

/** Validate each source entry exists as a directory on the host. */
export function validate_source_paths(sources: Source_Specification[]): void {
    if (sources.length === 0) {
        throw new Error('create_sandbox: sources array must be non-empty.');
    }
    for (const entry of sources) {
        if (!fs.existsSync(entry.host_path)) {
            throw new Error(`Source directory not found: ${entry.host_path}`);
        }
        if (!fs.statSync(entry.host_path).isDirectory()) {
            throw new Error(`Source path is not a directory: ${entry.host_path}`);
        }
    }
}

/**
 * Compute the patchlab's repository set ONCE. The per-repository iteration in
 * Phase 1 and Phase 2 uses this canonical list (`manifest_repositories`-
 * equivalent semantics: first-appearance order, byte-for-byte string equality,
 * no normalization).
 */
export function collect_unique_repositories(sources: Source_Specification[]): string[] {
    const seen = new Set<string>();
    const repositories: string[] = [];
    for (const entry of sources) {
        if (!seen.has(entry.repository_root)) {
            seen.add(entry.repository_root);
            repositories.push(entry.repository_root);
        }
    }
    return repositories;
}
