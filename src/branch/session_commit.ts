/**
 * Session-commit fan-out: extract the sandbox's session-exit diff into the
 * host's `patchlab/{id}` branch, once per repository the patchlab spans.
 *
 * The flow is:
 *   1. Stage all changes inside the container (one `git add -A`).
 *   2. For each repository the patchlab spans:
 *      a. Slice the staged diff with the repository's mount-name pathspec.
 *      b. Probe size, apply the per-repository cap.
 *      c. Verify the repository's `patchlab/{id}` branch exists.
 *      d. Path-rewrite the slice if any source's `mount_name !== source_prefix`.
 *      e. Apply + commit against a temporary index file.
 *   3. Advance the container's local HEAD once after the loop.
 *
 * Fan-out is best-effort and continue-on-failure: a per-repository failure
 * (apply rejected, oversized + declined, missing branch) writes a
 * per-repository `fallback.<basename>.patch` and the loop continues. The
 * user's working tree, index, and current branch are NEVER touched.
 *
 * `record_extraction_outcome` is the read-modify-write that persists the
 * fan-out's per-repository outcomes (commit shas + fallback paths) into the
 * session's `metadata.json`. It's grouped here because its inputs (`Commit_Session_Result`)
 * and its semantics ("the fan-out is authoritative for its repositories") only
 * make sense in this file's context.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import type { Transform } from 'node:stream';
import { logger } from '../logger.js';
import {
    build_archive_path,
    build_session_path,
    read_session_metadata,
    write_session_metadata,
} from '../archive.js';
import {
    manifest_repositories,
    read_manifest,
    type Source_Specification,
} from '../manifest.js';
import { make_diff_path_rewriter } from '../diff_path_rewrite.js';
import { safe_unlink } from '../safe_filesystem.js';
import { run_git, rev_parse } from './internals.js';
import { patchlab_branch_name } from './naming.js';
import { patchlab_branch_exists } from './predicates.js';
import {
    commit_tree_with_parent,
    make_temporary_index_path,
    with_index_env,
} from './create.js';

/** Default cap on session-diff size before the user is prompted. 256 MB. */
export const DEFAULT_MAX_DIFF_BYTES = 256 * 1024 * 1024;

interface Sandbox_Diff_Probe {
    /** Size of the staged diff in bytes (0 if no changes). */
    size_bytes: number;
    /** Path inside the sandbox where the diff is staged. */
    container_path: string;
}

/**
 * Inside the sandbox: stage all changes via `git add -A`. Runs ONCE per
 * session-exit (not per-repository) — the per-repository slicing step then
 * filters the staged diff via a pathspec.
 */
function stage_sandbox_changes(container_name: string, workspace: string): void {
    execFileSync(
        'podman',
        ['exec', '--workdir', workspace, container_name, 'git', 'add', '-A'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
}

/**
 * Inside the sandbox: emit a per-repository diff slice covering the listed
 * `mount_name`s and write it to a per-repository container-side temp file.
 * Path of the temp file includes the disambiguated repository basename so
 * concurrent fan-out cannot collide. Returns the file's path and size.
 *
 * `core.autocrlf=false` preserves byte-for-byte content; `core.quotePath=false`
 * keeps paths unquoted so the downstream path-rewriter's line-prefix matcher
 * works without dealing with C-style quoted paths.
 */
function slice_repository_diff_in_sandbox(
    container_name: string,
    workspace: string,
    patchlab_id: string,
    session_number: number,
    fallback_basename: string,
    mount_names: string[],
): Sandbox_Diff_Probe {
    const container_path = `/tmp/patchlab-diff-${patchlab_id}-${session_number}-${process.pid}-${fallback_basename}.bin`;
    // When `mount_name === ''` (empty-mount exclusivity case: the source IS
    // the repository root and is the only source), drop the pathspec entirely
    // — the whole workspace IS this repository's slice. Otherwise emit one
    // `<mount_name>/` pathspec per source in this repository.
    const pathspecs = mount_names
        .filter((name) => name !== '')
        .map((name) => `${name}/`);
    const script = pathspecs.length === 0
        ? 'set -e; output_path="$1"; '
        + 'git -c core.autocrlf=false -c core.quotePath=false diff --cached --binary HEAD > "$output_path"'
        : 'set -e; output_path="$1"; shift; '
        + 'git -c core.autocrlf=false -c core.quotePath=false diff --cached --binary HEAD -- "$@" > "$output_path"';
    execFileSync(
        'podman',
        [
            'exec', '--workdir', workspace, container_name,
            'sh', '-c', script, 'patchlab-slice',
            container_path,
            ...pathspecs,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const size_string = execFileSync(
        'podman',
        ['exec', container_name, 'stat', '-c', '%s', container_path],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const size_bytes = Number.parseInt(size_string.trim(), 10);
    return { size_bytes, container_path };
}

function clean_up_sandbox_diff_temporary_file(container_name: string, container_path: string): void {
    try {
        execFileSync(
            'podman',
            ['exec', container_name, 'rm', '-f', container_path],
            { stdio: 'pipe' },
        );
    } catch (_container_rm_failed) {
        /* best-effort */
    }
}

/**
 * Copy a sandbox-side diff temp file out to
 * `sessions/{n}/fallback.<basename>.patch` so the user never loses work even
 * when the per-repository auto-commit can't proceed. `fallback_basename` is
 * the disambiguated repository basename (see
 * `disambiguate_repository_basenames`).
 */
function copy_sandbox_diff_to_fallback(
    container_name: string,
    container_path: string,
    patchlab_id: string,
    session_number: number,
    fallback_basename: string,
): string {
    const directory = build_session_path(patchlab_id, session_number);
    fs.mkdirSync(directory, { recursive: true });
    const file_path = path.join(directory, `fallback.${fallback_basename}.patch`);
    execFileSync(
        'podman',
        ['cp', `${container_name}:${container_path}`, file_path],
        { stdio: 'pipe' },
    );
    return file_path;
}

/**
 * Compute disambiguated fallback-filename basenames per repository. The
 * fallback patch lives at `sessions/{n}/fallback.<basename>.patch`. When two
 * repositories share a basename (e.g., two repos both named `app/`), the
 * disambiguator appends an 8-hex SHA-256 of `realpath(repository_root)` (or
 * `repository_root` if realpath fails) so each repository's fallback lands at
 * a distinct path.
 */
export function disambiguate_repository_basenames(
    repositories: string[],
): Map<string, string> {
    const groups = new Map<string, string[]>();
    for (const repository_root of repositories) {
        const basename = path.basename(repository_root) || 'repository';
        const list = groups.get(basename) ?? [];
        list.push(repository_root);
        groups.set(basename, list);
    }
    const result = new Map<string, string>();
    for (const [basename, group] of groups) {
        if (group.length === 1) {
            result.set(group[0], basename);
            continue;
        }
        for (const repository_root of group) {
            let canonical: string;
            try {
                canonical = fs.realpathSync(repository_root);
            } catch {
                canonical = repository_root;
            }
            const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
            result.set(repository_root, `${basename}_${hash}`);
        }
    }
    return result;
}

/**
 * Stream the sandbox-side diff temp file into `git apply --cached --binary` on the
 * host via piped stdio. Awaits both child processes and surfaces a non-zero exit
 * with stderr context.
 *
 * Exported for unit coverage of the exit-code handling (a `cat` failure, or a
 * signal-killed child, must reject rather than silently "apply" empty input).
 */
export function stream_apply_from_sandbox(
    container_name: string,
    container_diff_path: string,
    repository_root: string,
    temporary_index: string,
    rewriter?: Transform,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const cat = spawn(
            'podman',
            ['exec', container_name, 'cat', container_diff_path],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        // No --directory flag: per-repository slices arrive repository-relative
        // (either because `mount_name === source_prefix` so the container's
        // diff is already host-correct, or because the path-rewriter Transform
        // — when piped in — substitutes mount_name segments with source_prefix
        // in unified-diff header lines). Either way, the host-side apply runs
        // at `repository_root` with no `--directory` flag.
        const apply_arguments = ['apply', '--cached', '--binary', '-'];

        const apply_proc = spawn('git', apply_arguments, {
            cwd: repository_root,
            env: { ...process.env, GIT_INDEX_FILE: temporary_index },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const apply_errors: Buffer[] = [];
        apply_proc.stderr.on('data', (chunk: Buffer) => apply_errors.push(chunk));
        // Drain `cat`'s stderr too: it both feeds the diagnostic on failure and
        // keeps the pipe from filling (and blocking `cat`) if it ever gets
        // chatty.
        const cat_errors: Buffer[] = [];
        cat.stderr.on('data', (chunk: Buffer) => cat_errors.push(chunk));

        // Tear down BOTH children on any failure. The common case — git apply
        // rejects with a non-zero exit — would otherwise leave the `cat`
        // `podman exec` running and its stdout pipe dangling; symmetrically a
        // `cat` failure would orphan the apply process. kill() is idempotent,
        // so calling it after a child has already exited is harmless.
        const fail = (error: Error): void => {
            cat.kill();
            apply_proc.kill();
            reject(error);
        };

        // Killing a child mid-pipe makes the writable stdin emit EPIPE; absorb
        // it so it does not surface as an unhandled 'error' event (the real
        // outcome is reported via the child 'error'/'close' handlers below).
        apply_proc.stdin.on('error', () => {});

        if (rewriter === undefined) {
            cat.stdout.pipe(apply_proc.stdin);
        } else {
            cat.stdout.pipe(rewriter).pipe(apply_proc.stdin);
            rewriter.on('error', fail);
        }

        // Settle only once BOTH children have exited, and inspect each exit
        // code. A `cat` failure (missing diff file, container gone) closes its
        // stdout early, so `git apply` sees empty input and exits 0 — without
        // this check the promise would resolve and the session would silently
        // "commit" nothing. `git apply`'s status takes precedence in the
        // message (it is the operation), then `cat`'s.
        // A separate "closed" flag is the not-yet-exited sentinel, kept distinct
        // from the exit code: a child killed by a signal closes with a null code
        // (and a signal name), and conflating that with 0 would launder a
        // signal death — e.g. the OOM killer reaping `git apply` — into success,
        // re-opening the very silent-"commit nothing" hole this guards against.
        let cat_closed = false;
        let apply_closed = false;
        let cat_exit: number | null = null;
        let apply_exit: number | null = null;
        let cat_signal: NodeJS.Signals | null = null;
        let apply_signal: NodeJS.Signals | null = null;
        const exit_detail = (code: number | null, signal: NodeJS.Signals | null): string => {
            return signal === null ? `exit ${code}` : `signal ${signal}`;
        };
        const settle = (): void => {
            if (!cat_closed || !apply_closed) {
                return;
            }
            if (apply_exit !== 0) {
                fail(new Error(
                    `git apply failed (${exit_detail(apply_exit, apply_signal)}): `
                    + Buffer.concat(apply_errors).toString('utf-8')
                ));
                return;
            }
            if (cat_exit !== 0) {
                fail(new Error(
                    `reading container diff failed (cat ${exit_detail(cat_exit, cat_signal)}): `
                    + Buffer.concat(cat_errors).toString('utf-8')
                ));
                return;
            }
            resolve();
        };

        cat.on('error', fail);
        apply_proc.on('error', fail);
        cat.on('close', (code, signal) => {
            cat_closed = true;
            cat_exit = code;
            cat_signal = signal;
            settle();
        });
        apply_proc.on('close', (code, signal) => {
            apply_closed = true;
            apply_exit = code;
            apply_signal = signal;
            settle();
        });
    });
}

export interface Commit_Session_Options {
    container_name: string;
    workspace: string;
    tool_name: string;
    /** ISO8601 timestamp of session creation, used in the commit message. */
    created_at: string;
    author_name?: string;
    author_email?: string;
    /** Size cap before the caller is asked to confirm transfer. Defaults to 256 MB. */
    max_diff_size_bytes?: number;
    /**
     * Invoked when the diff exceeds `max_diff_size_bytes`. Returning true proceeds with
     * the auto-commit. Returning false aborts (the diff is still copied to the session's
     * `fallback.patch` so the user doesn't lose work).
     *
     * When omitted entirely and the diff is over cap, `commit_session_to_branch` aborts
     * non-interactively: it copies the diff to `fallback.patch` and surfaces a clear
     * warning directing the user to raise the cap or apply manually (the fan-out
     * continues — this does not throw).
     */
    confirm_oversized?: (size_bytes: number) => Promise<boolean> | boolean;
}

export interface Commit_Session_Result {
    /**
     * Per-repository session commit SHA. Keyed on the patchlab's distinct
     * `repository_root` strings (from `manifest_repositories(manifest)`).
     * Values are the SHA of the session's commit on that repository's patchlab
     * branch, or `null` when no commit was produced for that repository. Under the
     * current single-repository invariant this map has exactly one entry.
     */
    commit_shas: Record<string, string | null>;
    /**
     * Per-repository fallback-patch path. Mirrors `commit_shas`'s keyset. A non-null
     * entry indicates the diff was written to that path because the branch
     * was missing, the diff exceeded the size cap, or `git apply` rejected
     * the diff for that repository.
     */
    fallback_patches: Record<string, string | null>;
}

/**
 * Commit the session's changes to the patchlab branches in EACH host
 * repository the patchlab spans. The flow iterates
 * `manifest_repositories(manifest)` and, for each repository:
 *
 *   1. Slice the diff using the repository's mount-name pathspec.
 *   2. Probe size and apply the per-repository cap.
 *   3. Check the repository's `patchlab/{id}` branch exists.
 *   4. Path-rewrite the slice if any source in the repository has
 *      `mount_name !== source_prefix`.
 *   5. Apply + commit via the existing streaming plumbing.
 *
 * Fan-out is best-effort, continue-on-failure: a per-repository failure
 * (apply rejected, oversized + declined, missing branch) writes a per-repository
 * fallback at `sessions/{n}/fallback.<basename>.patch` and continues to the
 * next repository. The container's HEAD is advanced ONCE at the end of the
 * fan-out so the next extraction's `git diff --cached HEAD` doesn't re-stage
 * already-committed work.
 *
 * The user's working tree, index, and current branch are not touched.
 */
export async function commit_session_to_branch(
    patchlab_id: string,
    session_number: number,
    options: Commit_Session_Options
): Promise<Commit_Session_Result> {
    const archive_directory = build_archive_path(patchlab_id);
    const manifest = read_manifest(archive_directory);
    const repositories = manifest_repositories(manifest);
    const branch = patchlab_branch_name(patchlab_id);
    const fallback_basenames = disambiguate_repository_basenames(repositories);

    // Stage every change inside the container ONCE. The per-repository slices
    // below all derive from the same staged state.
    stage_sandbox_changes(options.container_name, options.workspace);

    const commit_shas: Record<string, string | null> = {};
    const fallback_patches: Record<string, string | null> = {};
    const cap = options.max_diff_size_bytes ?? DEFAULT_MAX_DIFF_BYTES;

    for (const repository_root of repositories) {
        const result = await fan_out_to_one_repository({
            repository_root,
            patchlab_id,
            session_number,
            branch,
            cap,
            fallback_basename: fallback_basenames.get(repository_root) ?? path.basename(repository_root),
            sources_for_repository: manifest.sources.filter(
                (source) => source.repository_root === repository_root,
            ),
            options,
        });
        commit_shas[repository_root] = result.commit_sha;
        fallback_patches[repository_root] = result.fallback_path;
    }

    // Advance the container's HEAD once per session-exit regardless of how
    // many host repositories the fan-out touched. The `--allow-empty` flag
    // keeps it idempotent when the staged tree matches HEAD already. Failure
    // is logged but does NOT undo any host commits.
    try {
        advance_container_head(options.container_name, options.workspace);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(
            `Container HEAD advance failed after session commit fan-out (host commits are safe on their branches): ${message}`,
        );
    }

    return { commit_shas, fallback_patches };
}

interface Fan_Out_Context {
    repository_root: string;
    patchlab_id: string;
    session_number: number;
    branch: string;
    cap: number;
    fallback_basename: string;
    sources_for_repository: Source_Specification[];
    options: Commit_Session_Options;
}

/**
 * Run the commit-fan-out flow for ONE repository: slice its diff, apply size
 * cap, check branch existence, path-rewrite + apply + commit OR write a
 * per-repository fallback patch. Always cleans up the container-side slice
 * temp file. Returns the per-repository outcome the caller records into
 * the session metadata's maps.
 *
 * Extracted from `commit_session_to_branch` to keep that orchestrator's
 * cognitive complexity inside Sonar's S3776 threshold.
 */
async function fan_out_to_one_repository(context: Fan_Out_Context): Promise<Repository_Slice_Result> {
    const {
        repository_root, patchlab_id, session_number, branch, cap,
        fallback_basename, sources_for_repository, options,
    } = context;
    const mount_names = sources_for_repository.map((source) => source.mount_name);
    const slice = slice_repository_diff_in_sandbox(
        options.container_name,
        options.workspace,
        patchlab_id,
        session_number,
        fallback_basename,
        mount_names,
    );
    try {
        if (slice.size_bytes === 0) {
            return { commit_sha: null, fallback_path: null };
        }
        const oversized_result = await handle_oversized_slice(slice, cap, fallback_basename, branch, context);
        if (oversized_result !== null) {
            return oversized_result;
        }
        const missing_branch_result = handle_missing_branch(slice, fallback_basename, context);
        if (missing_branch_result !== null) {
            return missing_branch_result;
        }
        const rewriter = build_repository_path_rewriter(sources_for_repository);
        return await apply_and_commit_repository_slice({
            repository_root,
            branch,
            patchlab_id,
            session_number,
            fallback_basename,
            container_diff_path: slice.container_path,
            rewriter,
            options,
        });
    } finally {
        clean_up_sandbox_diff_temporary_file(options.container_name, slice.container_path);
    }
}

/**
 * Per-repository size-cap check. Returns the fan-out result when the slice
 * exceeds the cap and the user declined (or no confirmation hook was
 * supplied); returns `null` when the slice is under cap or the user accepted
 * (the caller proceeds to the apply step).
 */
async function handle_oversized_slice(
    slice: Sandbox_Diff_Probe,
    cap: number,
    fallback_basename: string,
    branch: string,
    context: Fan_Out_Context,
): Promise<Repository_Slice_Result | null> {
    if (slice.size_bytes <= cap) {
        return null;
    }

    const proceed = context.options.confirm_oversized
        ? await context.options.confirm_oversized(slice.size_bytes)
        : false;
    if (proceed) {
        return null;
    }

    const fallback = copy_sandbox_diff_to_fallback(
        context.options.container_name,
        slice.container_path,
        context.patchlab_id,
        context.session_number,
        fallback_basename,
    );
    warn_oversized(slice.size_bytes, cap, fallback, !!context.options.confirm_oversized, branch);
    return { commit_sha: null, fallback_path: fallback };
}

/**
 * Per-repository branch-existence check. Returns the fan-out result with a
 * fallback path when the repository's `patchlab/{id}` branch has been
 * manually deleted; returns `null` when the branch exists (caller proceeds).
 */
function handle_missing_branch(
    slice: Sandbox_Diff_Probe,
    fallback_basename: string,
    context: Fan_Out_Context,
): Repository_Slice_Result | null {
    if (patchlab_branch_exists(context.repository_root, context.patchlab_id)) {
        return null;
    }
    const fallback = copy_sandbox_diff_to_fallback(
        context.options.container_name,
        slice.container_path,
        context.patchlab_id,
        context.session_number,
        fallback_basename,
    );
    logger().warn(
        `Patchlab branch ${context.branch} no longer exists in ${context.repository_root}. `
        + `Diff saved to ${fallback}.\n`
        + 'Recreate the branch and apply the patch manually with: '
        + `git apply --binary ${fallback}`,
    );
    return { commit_sha: null, fallback_path: fallback };
}

/**
 * Build a path-rewrite Transform when ANY source in the repository has
 * `mount_name !== source_prefix`. Returns `undefined` for the identity case so
 * `stream_apply_from_sandbox` can wire `cat | git apply` directly without an
 * intermediate transform.
 */
function build_repository_path_rewriter(
    sources: Source_Specification[],
): Transform | undefined {
    const needs_rewrite = sources.some((source) => source.mount_name !== source.source_prefix);

    return needs_rewrite ? make_diff_path_rewriter(
        sources.map((source) => ({
            mount_name: source.mount_name,
            source_prefix: source.source_prefix,
        })),
    ) : undefined;
}

/**
 * Sync the container's local HEAD to its current working tree after a
 * successful host-side session commit. The container's git repository is purely
 * local — its HEAD is a private marker that `read_container_pending_diff`
 * reads to decide whether the container has uncommitted changes. Advancing
 * HEAD here makes that marker reflect the state actually extracted to the
 * host's patchlab branch; nothing else in the system depends on it.
 *
 * Uses `--allow-empty` because the staged tree may already equal HEAD
 * (e.g., if the next call happens before any new edits) and we want the
 * call to remain idempotent.
 */
function advance_container_head(container_name: string, workspace: string): void {
    execFileSync(
        'podman',
        ['exec', '--workdir', workspace, container_name, 'git', 'add', '-A'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    execFileSync(
        'podman',
        [
            'exec', '--workdir', workspace, container_name,
            'git', 'commit', '--allow-empty', '-m', 'patchlab: extracted to branch',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
}

interface Repository_Slice_Result {
    commit_sha: string | null;
    fallback_path: string | null;
}

interface Repository_Slice_Apply_Context {
    repository_root: string;
    branch: string;
    patchlab_id: string;
    session_number: number;
    fallback_basename: string;
    container_diff_path: string;
    rewriter: Transform | undefined;
    options: Commit_Session_Options;
}

/**
 * Per-repository helper: run the apply / write-tree / commit-tree / update-ref
 * plumbing for ONE repository's slice. The slice has already been written to
 * `container_diff_path` inside the sandbox; `rewriter` (when non-undefined) is
 * spliced into the pipeline between `podman exec cat` and `git apply` so
 * mount-name segments are rewritten to source-prefix segments before the apply.
 * On any failure, the slice is copied out to the per-repository fallback path
 * so the user's work survives.
 */
async function apply_and_commit_repository_slice(
    context: Repository_Slice_Apply_Context,
): Promise<Repository_Slice_Result> {
    const { repository_root, branch, patchlab_id, session_number, fallback_basename, container_diff_path, rewriter, options } = context;
    const branch_tip = rev_parse(repository_root, `refs/heads/${branch}`);
    const message = format_session_commit_message({
        session_number,
        patchlab_id,
        tool_name: options.tool_name,
        created_at: options.created_at,
    });

    const temporary_index = make_temporary_index_path(patchlab_id, `session-${session_number}-${fallback_basename}`);
    try {
        try {
            run_git(['read-tree', branch_tip], {
                cwd: repository_root,
                env: with_index_env(temporary_index),
            });

            await stream_apply_from_sandbox(
                options.container_name,
                container_diff_path,
                repository_root,
                temporary_index,
                rewriter,
            );

            const tree = run_git(
                ['write-tree'],
                { cwd: repository_root, env: with_index_env(temporary_index) }
            ).stdout.trim();

            const parent_tree = run_git(
                ['rev-parse', `${branch_tip}^{tree}`],
                { cwd: repository_root }
            ).stdout.trim();
            if (tree === parent_tree) {
                // Apply produced an empty tree — the slice's net change was a no-op
                // against the branch tip. Skip the commit.
                return { commit_sha: null, fallback_path: null };
            }

            const commit_sha = commit_tree_with_parent(
                repository_root,
                tree,
                [branch_tip],
                message,
                options.author_name,
                options.author_email
            );

            run_git(['update-ref', `refs/heads/${branch}`, commit_sha], { cwd: repository_root });
            return { commit_sha, fallback_path: null };
        } catch (error) {
            const fallback = copy_sandbox_diff_to_fallback(
                options.container_name, container_diff_path, patchlab_id, session_number, fallback_basename,
            );
            const message_text = error instanceof Error ? error.message : String(error);
            logger().warn(
                `Failed to commit session ${session_number} to ${branch} in ${repository_root}: ${message_text}\n`
                + `Diff saved to ${fallback}.\n`
                + 'Apply the patch manually with: '
                + `git apply --binary ${fallback}`,
            );
            return { commit_sha: null, fallback_path: fallback };
        }
    } finally {
        safe_unlink(temporary_index);
    }
}

function warn_oversized(
    size_bytes: number,
    cap_bytes: number,
    fallback_path: string,
    had_callback: boolean,
    branch: string,
): void {
    const detail = `Session diff is ${size_bytes} bytes (cap: ${cap_bytes}). `
        + `Diff saved to ${fallback_path}.\n`
        + 'Apply the patch manually with: '
        + `git apply --binary ${fallback_path}`;

    if (had_callback) {
        logger().warn(`Auto-commit aborted at user request — ${detail}`);
        return;
    }

    logger().warn(
        `Auto-commit aborted: diff exceeds ${cap_bytes}-byte cap and no confirmation hook supplied. `
        + `Re-run interactively (so you can confirm the transfer) or pass `
        + `max_diff_size_bytes higher.\n${detail}\nBranch: ${branch}`
    );
}

interface Session_Commit_Message_Info {
    session_number: number;
    patchlab_id: string;
    tool_name: string;
    created_at: string;
}

function format_session_commit_message(info: Session_Commit_Message_Info): string {
    return [
        `Session ${info.session_number} — patchlab ${info.patchlab_id}`,
        '',
        `Tool: ${info.tool_name}`,
        `Created: ${info.created_at}`,
    ].join('\n');
}

/**
 * Update the session's metadata.json with the result of the branch-commit step
 * via read-modify-write. Persists `commit_shas` and `fallback_patches` together
 * so the metadata reflects the current outcome.
 *
 * Per the `Session commit on sandbox exit` spec: the output map's keyset is
 * exactly `manifest_repositories(manifest)`. Pre-existing keys NOT in that set
 * (stale entries from a hand-edited manifest whose `sources` no longer mention
 * the repository) are DROPPED on this write. Values come from `outcome` for each
 * repository — the fan-out is authoritative, so an absent or `null` outcome
 * entry CLEARS any prior value rather than preserving it (e.g. a stale fallback
 * from a previous attempt this commit superseded).
 */
export function record_extraction_outcome(
    patchlab_id: string,
    session_number: number,
    outcome: Commit_Session_Result
): void {
    const existing = read_session_metadata(patchlab_id, session_number);
    if (!existing) {
        throw new Error(
            `Cannot record extraction outcome: session ${session_number} of patchlab ${patchlab_id} `
            + `has no metadata. Initial session metadata must be written when the sandbox starts.`
        );
    }

    const manifest = read_manifest(build_archive_path(patchlab_id));
    const repositories = manifest_repositories(manifest);
    const next_commit_shas: Record<string, string | null> = {};
    const next_fallback_patches: Record<string, string | null> = {};
    for (const repository_root of repositories) {
        // The outcome is authoritative for its repositories — `null` from the
        // fan-out explicitly clears any prior value (e.g. a stale fallback
        // from a previous attempt that this commit superseded). Treat
        // `undefined` as `null` per the spec's "undefined SHALL be treated
        // as null" rule.
        next_commit_shas[repository_root] = outcome.commit_shas[repository_root] ?? null;
        next_fallback_patches[repository_root] = outcome.fallback_patches[repository_root] ?? null;
    }

    existing.commit_shas = next_commit_shas;
    existing.fallback_patches = next_fallback_patches;
    write_session_metadata(patchlab_id, session_number, existing);
}
