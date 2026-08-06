/**
 * Apply commits from a patchlab branch onto the current host branch.
 *
 * The public entry is `apply_patchlab_branch`, which dispatches on the
 * requested mode:
 *
 *   - **cherry-pick** (default): each session commit is cherry-picked
 *     individually in session order, with already-applied commits skipped
 *     via `git cherry` patch-id comparison.
 *   - **merge-commit**: `git merge --no-ff patchlab/{id}` produces a single
 *     merge commit.
 *   - **merge-squash**: collapses the whole branch into one new commit,
 *     with an `--exclude-baseline` carve-out implemented by
 *     `git diff baseline..tip | git apply --index --3way` (avoids the
 *     temp-branch dance a real merge would need).
 *
 * `resolve_apply_repository` is the input-validator that pairs with the
 * `patchlab apply` and `patchlab patch` CLI handlers — it picks the
 * repository_root from `manifest_repositories(manifest)` against the
 * user-supplied `--repository <path>` value.
 */
import * as path from 'node:path';
import { build_archive_path } from '../archive.js';
import {
    manifest_repositories,
    read_manifest,
    type Sandbox_Manifest,
} from '../manifest.js';
import { run_git, run_git_capture_buffer, rev_parse } from './internals.js';
import { patchlab_branch_name } from './naming.js';
import { detect_submodules, patchlab_branch_exists } from './predicates.js';
import { list_session_commits } from './session_metadata.js';

/**
 * Resolve the `--repository <path>` value supplied to `patchlab apply` or
 * `patchlab patch` against the patchlab's manifest. Per multi-source-extraction
 * Decision 4:
 *   - Single-repository patchlab + value undefined → return the manifest's only repository.
 *   - Single-repository patchlab + value supplied → must match the manifest's only repository (after `path.resolve`).
 *   - Multi-repository patchlab + value undefined → throw (no default; user must pick).
 *   - Multi-repository patchlab + value supplied → must match an entry in `manifest_repositories(manifest)` (after `path.resolve`, with platform case-sensitivity).
 *
 * Value matching is `path.resolve`-only — NEVER realpath-resolved on either
 * side. The manifest layer's invariant (stored paths are `path.resolve`-only)
 * is the floor: matching it ensures the comparison is symmetric with the
 * manifest's own validation. Implementations SHALL NOT call `fs.realpathSync`
 * on the supplied value or on any manifest entry during this comparison.
 */
export function resolve_apply_repository(
    manifest: Sandbox_Manifest,
    supplied_value: string | undefined,
): string {
    const repositories = manifest_repositories(manifest);
    if (supplied_value === undefined) {
        if (repositories.length === 1) {
            return repositories[0];
        }

        throw new Error(
            `Patchlab spans multiple repositories. Re-run with --repository <path> to choose one:\n`
            + format_repository_choices(repositories),
        );
    }

    const resolved_input = path.resolve(supplied_value);
    const match = repositories.find((repository) => paths_equal(repository, resolved_input));
    if (match !== undefined) {
        return match;
    }

    throw new Error(
        `--repository value ${JSON.stringify(supplied_value)} (resolved to ${resolved_input}) `
        + `is not in the patchlab's repository set. Pick one of:\n`
        + format_repository_choices(repositories),
    );
}

/**
 * Render the patchlab's repositories as a copy-pasteable `--repository <path>`
 * list, one per line. Used by `resolve_apply_repository`'s "missing flag" and
 * "no-match" error paths so the user always sees the exact set of acceptable
 * values in the manifest's canonical form.
 */
function format_repository_choices(repositories: string[]): string {
    return repositories.map((repository) => `  --repository ${repository}`).join('\n');
}

function paths_equal(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    if (process.platform === 'win32') {
        const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase();
        return normalize(a) === normalize(b);
    }

    // macOS HFS+ and APFS are case-insensitive by default; matching the
    // manifest layer's `paths_equal_for_host` is the consistency target.
    // Other POSIX hosts are case-sensitive.
    return (process.platform === 'darwin')
        ? a.toLowerCase() === b.toLowerCase()
        : false;
}

export type Apply_Mode = 'cherry-pick' | 'merge-commit' | 'merge-squash';

export interface Apply_Options {
    /** Apply only this session number; if undefined, apply every session. */
    session_number?: number;
    /** Apply mode (default: 'cherry-pick'). */
    mode?: Apply_Mode;
    /** Include the baseline commit (default: false). */
    include_baseline?: boolean;
}

export interface Applied_Item {
    /** null indicates the baseline commit; otherwise the originating session number. */
    session_number: number | null;
    commit_sha: string;
}

export interface Skipped_Item {
    session_number: number | null;
    commit_sha: string;
    reason: 'already-applied';
}

export interface Apply_Conflict {
    session_number: number | null;
    commit_sha: string;
    /** Submodule paths involved in the failing commit, when applicable. */
    submodule_paths: string[];
    message: string;
}

export interface Apply_Result {
    mode: Apply_Mode;
    applied: Applied_Item[];
    skipped: Skipped_Item[];
    /** Set when cherry-pick or merge stopped at a conflict. */
    conflict?: Apply_Conflict;
    /** Resulting HEAD commit on the current branch when the apply succeeded under merge modes. */
    merge_commit_sha?: string;
    /** True when there were no commits to apply (and none were skipped). */
    nothing_to_apply: boolean;
}

/**
 * Apply commits from `patchlab/{id}` onto the current branch.
 *
 * Cherry-pick (default): each session commit is cherry-picked individually in session order.
 * Merge-commit: the patchlab branch tip is merged with `--no-ff`, producing a merge commit.
 * Merge-squash: the patchlab branch is squashed into a single new commit.
 *
 * Already-applied session commits (per `git cherry`, patch-id comparison) are skipped in
 * cherry-pick mode. Merge modes defer to git's own conflict handling.
 *
 * On conflict, the working tree is left in standard git conflict state and the result
 * carries a `conflict` entry identifying the failing commit and any submodule paths.
 */
export function apply_patchlab_branch(
    repository_root: string,
    patchlab_id: string,
    options?: Apply_Options
): Apply_Result {
    const mode: Apply_Mode = options?.mode ?? 'cherry-pick';
    const branch = patchlab_branch_name(patchlab_id);

    if (!patchlab_branch_exists(repository_root, patchlab_id)) {
        throw new Error(
            `Patchlab branch ${branch} does not exist in ${repository_root}.`
        );
    }

    const manifest = read_manifest(build_archive_path(patchlab_id));
    const baseline_commit_sha = manifest.baseline_commit_shas[repository_root] ?? null;
    const include_baseline = options?.include_baseline ?? false;

    reject_unsupported_merge_combinations(mode, options?.session_number, baseline_commit_sha, include_baseline);

    const candidates = collect_apply_candidates(
        patchlab_id,
        repository_root,
        baseline_commit_sha,
        include_baseline,
        options?.session_number,
    );

    if (candidates.length === 0) {
        return {
            mode,
            applied: [],
            skipped: [],
            nothing_to_apply: true,
        };
    }

    if (mode === 'cherry-pick') {
        return cherry_pick_candidates(repository_root, branch, candidates);
    }

    if (mode === 'merge-squash' && !include_baseline && baseline_commit_sha) {
        return squash_excluding_baseline(repository_root, branch, baseline_commit_sha, candidates);
    }

    return merge_patchlab_branch(repository_root, branch, mode, candidates);
}

/**
 * Refuse merge-mode combinations whose semantics are either incoherent or require
 * temp-branch plumbing that this implementation does not provide. The user gets a
 * clear pointer to cherry-pick mode, where per-session and baseline-exclusion are
 * naturally supported.
 */
function reject_unsupported_merge_combinations(
    mode: Apply_Mode,
    session_number: number | undefined,
    baseline_commit_sha: string | null,
    include_baseline: boolean
): void {
    if (mode === 'cherry-pick') {
        return;
    }

    if (session_number !== undefined) {
        throw new Error(
            `--session N is only supported in cherry-pick mode. `
            + `Run without --merge to apply a single session.`
        );
    }

    if (mode === 'merge-commit' && !include_baseline && baseline_commit_sha) {
        throw new Error(
            `--merge / --merge=commit requires --include-baseline when the patchlab has a `
            + `baseline commit. Use cherry-pick mode (omit --merge) to skip the baseline cleanly, `
            + `or pass --include-baseline to merge the whole branch.`
        );
    }
}

function collect_apply_candidates(
    patchlab_id: string,
    repository_root: string,
    baseline_commit_sha: string | null,
    include_baseline: boolean,
    session_number: number | undefined,
): Applied_Item[] {
    const sessions = list_session_commits(patchlab_id, repository_root);
    const candidates: Applied_Item[] = [];

    if (include_baseline && baseline_commit_sha) {
        candidates.push({ session_number: null, commit_sha: baseline_commit_sha });
    }

    if (session_number === undefined) {
        for (const session of sessions) {
            candidates.push({
                session_number: session.session_number,
                commit_sha: session.commit_sha,
            });
        }
    } else {
        const target = sessions.find((session) => session.session_number === session_number);
        if (target) {
            candidates.push({
                session_number: target.session_number,
                commit_sha: target.commit_sha,
            });
        }
    }

    return candidates;
}

function cherry_pick_candidates(
    repository_root: string,
    branch: string,
    candidates: Applied_Item[]
): Apply_Result {
    const current_branch = read_current_branch(repository_root);
    const cherry_summary = compute_cherry_summary(repository_root, current_branch, branch);

    const applied: Applied_Item[] = [];
    const skipped: Skipped_Item[] = [];

    for (const candidate of candidates) {
        if (cherry_summary.succeeded && !cherry_summary.unapplied.has(candidate.commit_sha)) {
            skipped.push({ ...candidate, reason: 'already-applied' });
            continue;
        }

        const cherry_pick_result = run_git(
            ['cherry-pick', candidate.commit_sha],
            { cwd: repository_root, allow_failure: true }
        );

        if (cherry_pick_result.status !== 0) {
            const submodule_paths = detect_submodule_paths_in_commit(
                repository_root,
                candidate.commit_sha
            );
            return {
                mode: 'cherry-pick',
                applied,
                skipped,
                conflict: {
                    session_number: candidate.session_number,
                    commit_sha: candidate.commit_sha,
                    submodule_paths,
                    message: cherry_pick_result.stderr.trim() || cherry_pick_result.stdout.trim(),
                },
                nothing_to_apply: false,
            };
        }

        applied.push(candidate);
    }

    return {
        mode: 'cherry-pick',
        applied,
        skipped,
        nothing_to_apply: false,
    };
}

/**
 * Squash all session commits into a single new commit on the current branch, excluding
 * the patchlab's baseline commit. Implemented via `git diff baseline..tip | git apply`,
 * avoiding the temp-branch dance a real merge would require.
 *
 * On apply conflict the working tree is left in standard git conflict state — same as
 * cherry-pick — and the result carries a `conflict` entry.
 */
function squash_excluding_baseline(
    repository_root: string,
    branch: string,
    baseline_commit_sha: string,
    candidates: Applied_Item[]
): Apply_Result {
    // Refuse to squash when the index already holds staged changes: this path
    // applies the session diff into the index with `--index` and then commits
    // it, so any pre-existing staged work would be swept into the squash commit.
    // Fail closed BEFORE any mutation rather than silently absorbing it.
    // (`git diff --cached --quiet` exits 0 when the index matches HEAD, non-zero
    // when it does not — or on error, which we also treat as a reason to abort.)
    const staged_index_check = run_git(
        ['diff', '--cached', '--quiet'],
        { cwd: repository_root, allow_failure: true }
    );
    if (staged_index_check.status !== 0) {
        throw new Error(
            `Refusing to squash-merge ${branch}: the index in ${repository_root} has pre-existing staged `
            + `changes. The squash applies the session diff into the index and commits it, which would sweep `
            + `those staged changes into the squash commit. Commit or unstage them first, then re-run.`
        );
    }

    // Capture the binary diff as raw bytes and feed the SAME bytes back to
    // `git apply` as a Buffer — a UTF-8 round-trip here would replace high bytes
    // of latin1/non-UTF-8 text files with U+FFFD, making apply reject or (worse)
    // silently writing corrupted content into the squash commit.
    const diff_result = run_git_capture_buffer(
        ['diff', '--binary', `${baseline_commit_sha}..${branch}`],
        { cwd: repository_root }
    );
    const diff = diff_result.stdout;

    if (diff.length === 0) {
        return {
            mode: 'merge-squash',
            applied: [],
            skipped: [],
            nothing_to_apply: true,
        };
    }

    const apply_result = run_git(
        ['apply', '--index', '--3way', '-'],
        { cwd: repository_root, input: diff, allow_failure: true }
    );

    if (apply_result.status !== 0) {
        return {
            mode: 'merge-squash',
            applied: [],
            skipped: [],
            conflict: {
                session_number: null,
                commit_sha: branch,
                submodule_paths: [],
                message: apply_result.stderr.trim() || apply_result.stdout.trim(),
            },
            nothing_to_apply: false,
        };
    }

    const commit_result = run_git(
        ['commit', '-m', `Squash merge of ${branch} (sessions only)`],
        { cwd: repository_root, allow_failure: true }
    );
    if (commit_result.status !== 0) {
        return {
            mode: 'merge-squash',
            applied: [],
            skipped: [],
            conflict: {
                session_number: null,
                commit_sha: branch,
                submodule_paths: [],
                message: `Squash is staged but git commit failed (commit hook, GPG, or identity not set): `
                    + (commit_result.stderr.trim() || commit_result.stdout.trim()),
            },
            nothing_to_apply: false,
        };
    }

    const merge_commit_sha = rev_parse(repository_root, 'HEAD');
    return {
        mode: 'merge-squash',
        applied: candidates,
        skipped: [],
        merge_commit_sha,
        nothing_to_apply: false,
    };
}

function merge_patchlab_branch(
    repository_root: string,
    branch: string,
    mode: 'merge-commit' | 'merge-squash',
    candidates: Applied_Item[]
): Apply_Result {
    const merge_arguments = ['merge'];
    if (mode === 'merge-commit') {
        merge_arguments.push('--no-ff');
    } else {
        merge_arguments.push('--squash');
    }
    merge_arguments.push(branch);

    const merge_result = run_git(merge_arguments, {
        cwd: repository_root,
        allow_failure: true,
    });

    if (merge_result.status !== 0) {
        return {
            mode,
            applied: [],
            skipped: [],
            conflict: {
                session_number: null,
                commit_sha: branch,
                submodule_paths: [],
                message: merge_result.stderr.trim() || merge_result.stdout.trim(),
            },
            nothing_to_apply: false,
        };
    }

    if (mode === 'merge-squash') {
        const commit_message = `Squash merge of ${branch}`;
        const commit_result = run_git(
            ['commit', '-m', commit_message],
            { cwd: repository_root, allow_failure: true }
        );
        if (commit_result.status !== 0) {
            return {
                mode,
                applied: [],
                skipped: [],
                conflict: {
                    session_number: null,
                    commit_sha: branch,
                    submodule_paths: [],
                    message: `Merge is staged but git commit failed (commit hook, GPG, or identity not set): `
                        + (commit_result.stderr.trim() || commit_result.stdout.trim()),
                },
                nothing_to_apply: false,
            };
        }
    }

    const merge_commit_sha = rev_parse(repository_root, 'HEAD');
    return {
        mode,
        applied: candidates,
        skipped: [],
        merge_commit_sha,
        nothing_to_apply: false,
    };
}

interface Cherry_Summary {
    succeeded: boolean;
    /** Commits on `branch_ref` whose patch IDs are NOT yet present on `upstream_ref`. */
    unapplied: Set<string>;
}

function compute_cherry_summary(
    repository_root: string,
    upstream_ref: string,
    branch_ref: string
): Cherry_Summary {
    const cherry = run_git(
        ['cherry', upstream_ref, branch_ref],
        { cwd: repository_root, allow_failure: true }
    );
    const unapplied = new Set<string>();
    if (cherry.status !== 0) {
        return { succeeded: false, unapplied };
    }
    for (const line of cherry.stdout.split('\n')) {
        const match = /^\+\s+([0-9a-f]+)/.exec(line);
        if (match) {
            unapplied.add(match[1]);
        }
    }
    return { succeeded: true, unapplied };
}

function read_current_branch(repository_root: string): string {
    const result = run_git(
        ['symbolic-ref', '--short', 'HEAD'],
        { cwd: repository_root, allow_failure: true }
    );
    if (result.status === 0) {
        return result.stdout.trim();
    }
    return 'HEAD';
}

function detect_submodule_paths_in_commit(
    repository_root: string,
    commit_sha: string
): string[] {
    const known_submodules = detect_submodules(repository_root);
    if (known_submodules.length === 0) {
        return [];
    }
    const result = run_git(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', commit_sha],
        { cwd: repository_root, allow_failure: true }
    );
    if (result.status !== 0) {
        return [];
    }
    const changed_paths = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const matched = new Set<string>();
    for (const changed_path of changed_paths) {
        for (const submodule of known_submodules) {
            const submodule_prefix = submodule.endsWith('/') ? submodule : submodule + '/';
            if (changed_path === submodule || changed_path.startsWith(submodule_prefix)) {
                matched.add(submodule);
            }
        }
    }
    return [...matched];
}
