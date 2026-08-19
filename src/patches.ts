import * as fs from 'node:fs';
import * as path from 'node:path';
import { build_archive_path, read_session_metadata } from './archive.js';
import { manifest_primary_source, manifest_repositories, read_manifest, resolve_manifest_tool, type Sandbox_Manifest } from './manifest.js';
import {
    compose_diff_against_baseline_with_pending,
    read_commit_diff,
    read_cumulative_diff,
    resolve_apply_repository,
    resolve_diff_start_reference,
    resolve_repository_root,
} from './branch/index.js';
import {
    container_running,
    exec_container,
    exec_container_capture_buffer,
} from './container_runtime.js';
import { get_provider, compute_container_workspace_path } from './tools/index.js';

/**
 * Generate the cumulative unified diff for a patchlab.
 *
 * Returns one coherent unified diff anchored at the patchlab's baseline (or
 * `branch_creation_point` if no baseline exists), covering both committed
 * sessions on the host's patchlab branch AND any pending working-tree changes
 * from the live container.
 *
 * Two paths:
 *   - **No live pending changes** (container exited or no working-tree diff
 *     against its HEAD): returns the host-branch cumulative diff
 *     (`baseline..patchlab/{id}`). This is the common case after a session has
 *     exited and its changes have been committed via the extraction flow.
 *   - **Pending changes present**: creates a temporary host worktree at the
 *     patchlab branch tip, applies the container's pending patch via `git
 *     apply --index`, and emits a single `git diff --cached <baseline>`
 *     covering both committed sessions and pending changes. Replaces the
 *     earlier "concat two diffs" strategy, which produced overlapping hunks
 *     that `git apply` rejected when committed and pending touched the same
 *     line ranges.
 *
 * Returns the empty string when no baseline can be derived AND there are no
 * pending changes (legacy archive without a recorded baseline or
 * branch_creation_point).
 */
export interface Generate_Patch_Options {
    /**
     * Optional `--repository <path>` filter. When supplied, the cumulative
     * diff is scoped to that single repository. When omitted on a
     * multi-repository patchlab, every repository's cumulative diff is
     * emitted in `manifest_repositories(manifest)` order, each preceded by
     * a comment-style separator (`# === Patch for <repository_root> ===`).
     * Single-repository patchlabs ignore the flag's absence and emit one
     * diff (matching the pre-multi-source-extraction behavior byte-for-byte).
     */
    repository_root?: string;
}

export function generate_patch(patchlab_id: string, options?: Generate_Patch_Options): string {
    const manifest = read_manifest(build_archive_path(patchlab_id));
    const repositories = manifest_repositories(manifest);

    if (options?.repository_root !== undefined) {
        const chosen = resolve_apply_repository(manifest, options.repository_root);
        return generate_patch_for_repository(patchlab_id, manifest, chosen);
    }

    if (repositories.length === 1) {
        return generate_patch_for_repository(patchlab_id, manifest, repositories[0]);
    }

    // Multi-repository, no `--repository`: emit one diff per repository in
    // `manifest_repositories(manifest)` order, each prefixed by a comment-
    // style separator that `git apply` ignores. The user can split the output
    // by separator and apply each chunk independently with the matching
    // `--repository` flag.
    const sections: string[] = [];
    for (const repository_root of repositories) {
        const repository_diff = generate_patch_for_repository(patchlab_id, manifest, repository_root);
        sections.push(`# === Patch for ${repository_root} ===\n${repository_diff}`);
    }
    return sections.join('');
}

/**
 * Per-repository diff: cumulative commits on `repository_root`'s patchlab
 * branch plus the slice of pending container changes scoped to its mounts.
 *
 * For single-repository patchlabs (or when the chosen repository is the
 * patchlab's only repository), pending changes from the container are
 * captured via the existing whole-workspace `git diff` and composed with
 * the branch tip. For multi-repository patchlabs, slicing the pending diff
 * per repository is currently NOT IMPLEMENTED — the function emits only
 * the committed-session cumulative diff for the chosen repository. The
 * limitation is documented for users and a follow-up task can add slicing
 * if it proves a real need.
 */
function generate_patch_for_repository(
    patchlab_id: string,
    manifest: Sandbox_Manifest,
    repository_root: string,
): string {
    const baseline_commit_sha = manifest.baseline_commit_shas[repository_root] ?? null;
    const branch_creation_point_sha = manifest.branch_creation_point_shas[repository_root] ?? null;

    const repositories = manifest_repositories(manifest);
    const is_single_repository = repositories.length === 1 && repositories[0] === repository_root;
    const pending = is_single_repository ? read_container_pending_diff(manifest) : Buffer.alloc(0);

    if (pending.length === 0) {
        return read_cumulative_diff(
            repository_root,
            patchlab_id,
            baseline_commit_sha,
            branch_creation_point_sha,
        );
    }

    const start_reference = resolve_diff_start_reference(
        repository_root,
        patchlab_id,
        baseline_commit_sha,
        branch_creation_point_sha,
    );
    if (start_reference === null) {
        // No baseline / creation point to compose against: the `--binary` pending
        // diff IS the patch. This is a display-only path (no host-side
        // `git apply`), so decoding to a string here cannot cause an apply
        // rejection; the byte-exact path that matters is the compose branch below.
        return pending.toString('utf-8');
    }

    return compose_diff_against_baseline_with_pending(
        repository_root,
        patchlab_id,
        start_reference,
        pending,
    );
}

/**
 * Capture the container's working-tree diff against its current HEAD as a
 * unified patch. Returns `''` when the container is not running or has no
 * pending changes.
 *
 * The "stage everything" step is a means to surface untracked files in the
 * diff; the working tree is restored afterwards (the user's tool may still
 * be operating on it).
 */
function read_container_pending_diff(manifest: Sandbox_Manifest): Buffer {
    if (!container_running(manifest.container_name)) {
        return Buffer.alloc(0);
    }

    const tool_name = resolve_manifest_tool(manifest);
    const provider = get_provider(tool_name);
    const cwd = compute_container_workspace_path(provider);
    const name = manifest.container_name;

    try {
        exec_container(name, ['git', 'add', '-A'], { cwd });
        // `--binary` emits a fully applicable patch for binary files (base85
        // blob diffs) instead of the default `"Binary files X and Y differ"`
        // marker — required so the host-side `git apply --index` in
        // `compose_diff_against_baseline_with_pending` can ingest binary
        // changes. The final cumulative diff against the baseline is
        // re-rendered without `--binary`, so the user-facing patch still uses
        // the textual binary marker rather than embedding raw blob deltas.
        // Capture as raw bytes: the patch may contain the high bytes of
        // latin1/non-UTF-8 files, which a UTF-8 decode would replace with U+FFFD
        // before the host-side `git apply` ever sees them.
        const captured = exec_container_capture_buffer(name, ['git', 'diff', '--cached', '--binary', 'HEAD'], { cwd });
        // Treat an empty / whitespace-only capture as "no pending changes". The
        // `latin1` view is a lossless byte→char mapping used ONLY for the
        // emptiness check; the returned Buffer keeps the original bytes intact.
        return captured.toString('latin1').trim() === '' ? Buffer.alloc(0) : captured;
    } finally {
        try {
            exec_container(name, ['git', 'reset'], { cwd });
        } catch (_git_reset_failed) {
            // Best-effort restore; the original `git add -A` was a read-only
            // probe from the user's perspective, so a failed reset is logged
            // implicitly via exec_container's exit code but does not propagate.
        }
    }
}

/**
 * Generate the unified diff for a single session's commit.
 *
 * Returns an empty string if the session produced no code changes
 * (its `commit_sha` is null). Throws if no session metadata exists.
 */
export function generate_session_patch(patchlab_id: string, session_number: number): string {
    const manifest = read_manifest(build_archive_path(patchlab_id));
    const primary_repository = manifest_primary_source(manifest).repository_root;
    const metadata = read_session_metadata(patchlab_id, session_number);
    if (!metadata) {
        throw new Error(
            `No metadata found for session ${session_number} of patchlab ${patchlab_id}.`
        );
    }

    const commit_sha = metadata.commit_shas[primary_repository] ?? null;
    if (!commit_sha) {
        return '';
    }

    const repository_root = resolve_repository_root(patchlab_id);
    return read_commit_diff(repository_root, commit_sha);
}

/** Write a patch to a file (returning the resolved path), or echo it back when no path is given. */
export function write_patch(patch: string, output_path?: string): string {
    if (output_path) {
        const resolved = path.resolve(output_path);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, patch, 'utf-8');
        return resolved;
    }

    return patch;
}
