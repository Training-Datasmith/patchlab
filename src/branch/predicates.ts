/**
 * State queries about a host repository or a patchlab branch — every
 * "is X true?" check the subsystem needs, plus the `resolve_repository_root`
 * helper that reads the manifest's repository_root (read-migrating the legacy
 * empty-string shape when present).
 *
 * Why grouped: every other file in the subsystem reads these predicates to
 * decide whether to proceed (`is_git_repository` gates resume reachability,
 * `branch_exists` gates apply, `patchlab_branch_exists` gates destroy's
 * idempotent-missing path). Concentrating them here keeps every consumer
 * importing from one place.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { build_archive_path, get_repository_root } from '../archive.js';
import {
    manifest_primary_source,
    read_manifest,
    write_manifest,
} from '../manifest.js';
import { run_git } from './internals.js';
import { patchlab_branch_name } from './naming.js';

/**
 * Non-throwing repository-reachability check. Returns `true` when
 * `git rev-parse --git-dir` succeeds at `repository_root`. Used by the resume
 * pre-flight to enumerate every unreachable repository in one pass (`assert_*`
 * variants short-circuit; this one composes).
 */
export function is_git_repository(repository_root: string): boolean {
    const result = run_git(
        ['rev-parse', '--git-dir'],
        { cwd: repository_root, allow_failure: true },
    );
    return result.status === 0;
}

/** Whether the working tree at `repository_root` has any uncommitted changes (tracked or untracked, ignoring gitignored). */
export function is_working_tree_dirty(repository_root: string): boolean {
    const result = run_git(['status', '--porcelain'], { cwd: repository_root });
    return result.stdout.trim() !== '';
}

/** Detect git submodules at `repository_root`. Returns array of submodule paths (relative). Empty if none. */
export function detect_submodules(repository_root: string): string[] {
    const gitmodules_path = path.join(repository_root, '.gitmodules');
    if (!fs.existsSync(gitmodules_path)) {
        return [];
    }
    const content = fs.readFileSync(gitmodules_path, 'utf-8');
    const paths: string[] = [];
    for (const line of content.split('\n')) {
        const match = /^\s*path\s*=\s*(.+)$/.exec(line);
        if (match) {
            paths.push(match[1].trim());
        }
    }
    return paths;
}

/** Whether the branch `patchlab/{id}` exists in the host repository. */
export function patchlab_branch_exists(repository_root: string, patchlab_id: string): boolean {
    return branch_exists(repository_root, patchlab_branch_name(patchlab_id));
}

/** Whether a named branch exists in the host repository. */
export function branch_exists(repository_root: string, branch: string): boolean {
    const result = run_git(
        ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd: repository_root, allow_failure: true },
    );
    return result.status === 0;
}

/**
 * Throws when `repository_root` is not a git repository. The error message
 * names the patchlab id so the user can pin the failure to a specific
 * patchlab — useful when a manifest's recorded repository_root has been
 * moved, deleted, or tampered with.
 */
function assert_is_git_repository(repository_root: string, patchlab_id: string): void {
    if (is_git_repository(repository_root)) {
        return;
    }
    throw new Error(
        `Patchlab ${patchlab_id} manifest points repository_root at ${repository_root}, `
        + `but that location is not a git repository. The repository may have been moved, `
        + `deleted, or the manifest may have been tampered with.`,
    );
}

/**
 * Resolve the host repository root for a patchlab.
 * Prefers `repository_root` from the manifest; if missing (legacy), recomputes
 * via `get_repository_root` and persists the value back to the manifest.
 *
 * Defense in depth: when a value is read from the manifest, verify it actually
 * is a git repository before returning, so a manifest pointing at a non-git or
 * deleted path is rejected rather than silently driving git operations (e.g.,
 * `git branch -D patchlab/{id}`) against it. NOTE: this only confirms the path
 * IS a git repository — it does not verify it is the ORIGINALLY-intended one, so
 * a manifest redirected to a DIFFERENT valid repository is not caught here.
 */
export function resolve_repository_root(patchlab_id: string): string {
    const archive_directory = build_archive_path(patchlab_id);
    const manifest = read_manifest(archive_directory);
    const primary = manifest_primary_source(manifest);

    // When the legacy-synthesis path could not resolve `repository_root`
    // (the very old `repository_root: null` legacy shape), it leaves the
    // synthesized entry's `repository_root` as an empty string and the
    // caller recomputes here from `host_path`. The recomputed
    // `repository_root` plus the synthesized `source_prefix` together
    // determine the canonical `host_path` (`host_path === path.join(root,
    // prefix)`) — overwriting `host_path` with the recomputed root alone
    // would break the writer invariant for any legacy entry whose
    // `source_prefix` is non-empty. The recomputed values are persisted
    // back so subsequent reads hit the new shape directly.
    if (primary.repository_root === '') {
        const old_key = primary.repository_root;
        const recomputed = get_repository_root(primary.host_path);
        primary.repository_root = recomputed;
        primary.host_path = primary.source_prefix === ''
            ? recomputed
            : `${recomputed.replaceAll('\\', '/')}/${primary.source_prefix}`;
        // Rekey the per-repository SHA maps so subsequent lookups against
        // `sources[0].repository_root` resolve. Without this, baseline /
        // creation-point SHAs synthesized from legacy single-key fields would
        // be silently dropped (the synthesis keyed them on the empty string
        // and the recomputed root would never match).
        rekey_repository_map(manifest.baseline_commit_shas, old_key, recomputed);
        rekey_repository_map(manifest.branch_creation_point_shas, old_key, recomputed);
        write_manifest(archive_directory, manifest);
        return recomputed;
    }

    assert_is_git_repository(primary.repository_root, patchlab_id);
    return primary.repository_root;
}

function rekey_repository_map<T>(
    map: Record<string, T>,
    old_key: string,
    new_key: string,
): void {
    if (old_key === new_key || !Object.hasOwn(map, old_key)) {
        return;
    }
    map[new_key] = map[old_key];
    delete map[old_key];
}
