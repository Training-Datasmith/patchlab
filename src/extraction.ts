import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';
import {
    ARCHIVE_ARTIFACTS_DIRECTORY,
    build_session_path,
    read_session_metadata,
    write_session_metadata,
} from './archive.js';
import {
    assert_artifact_filesystem_type,
    assert_unique_archive_subpaths,
    validate_archive_subpath,
    type Extractable_Artifact,
} from './extractable_artifact.js';
import {
    copy_from_container,
    exec_container,
} from './podman.js';
import type { Tool_Provider } from './tools/types.js';

/**
 * Best-effort extraction of human-readable history from the sandbox into
 * `sessions/{n}/history/`. Captures `git log --oneline` from the workspace and
 * `${image_home}/.bash_history` from the user's home. Missing files or failing
 * commands log a warning and do not throw. `image_home` honors any per-provider
 * override declared in a configured-provider manifest.
 */
export function extract_history(
    container_name: string,
    workspace: string,
    image_home: string,
    patchlab_id: string,
    session_number: number
): void {
    const history_directory = build_session_path(patchlab_id, session_number, 'history');
    fs.mkdirSync(history_directory, { recursive: true });

    extract_git_log(container_name, workspace, history_directory);
    extract_bash_history(container_name, image_home, history_directory);
}

function extract_git_log(
    container_name: string,
    workspace: string,
    history_directory: string
): void {
    try {
        const log = exec_container(container_name, ['git', 'log', '--oneline'], { cwd: workspace });
        fs.writeFileSync(path.join(history_directory, 'git-log.txt'), log, 'utf-8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: git log extraction failed — ${message}`);
    }
}

function extract_bash_history(
    container_name: string,
    image_home: string,
    history_directory: string
): void {
    const bash_history_path = `${image_home}/.bash_history`;
    // Bash history is best-effort: an absent file is skipped silently, and a
    // probe or copy failure (container gone, etc.) only warns — it is not a
    // tracked artifact, so it never forces the session to `interrupted`. The
    // existence probe is inside the try because it can now throw on a genuine
    // exec failure (see container_path_exists).
    try {
        if (!container_path_exists(container_name, bash_history_path)) {
            return;
        }

        copy_from_container(
            container_name,
            bash_history_path,
            path.join(history_directory, 'bash-history.txt')
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: bash history extraction failed — ${message}`);
    }
}

export interface Artifact_Extraction_Result {
    /** Artifact names that existed in the container and were successfully copied. */
    extracted: string[];
    /**
     * Artifact names whose source path EXISTED in the container but extraction
     * failed. Indicates lost data (the artifact was produced but did not make it
     * to the archive); a non-empty list forces the session status to `interrupted`.
     */
    produced_but_failed: string[];
    /**
     * Artifact names rejected by host-side validation (subpath validator,
     * uniqueness asserter, post-write filesystem-type check). Distinct from
     * `produced_but_failed` because the rejection happens before — or
     * independently of — the container path being consulted, so this is a
     * provider-declaration bug rather than a lost-data signal. A non-empty
     * list does NOT force the session to `interrupted`.
     */
    skipped_invalid: string[];
}

/**
 * Best-effort extraction of every artifact declared by the tool provider into
 * `sessions/{n}/artifacts/<archive_subpath>` under the per-session fence
 * directory (named by `ARCHIVE_ARTIFACTS_DIRECTORY`).
 *
 * Layout:
 * - The `artifacts/` fence is created lazily on first successful copy attempt;
 *   when the provider declares zero artifacts (or all are filtered out), the
 *   fence is not created at all.
 * - Per-artifact subpaths are validated by `validate_archive_subpath` before
 *   joining — a rejection skips that artifact and leaves it for the operator
 *   to fix in the provider declaration.
 * - The artifact array is checked for duplicate `archive_subpath` values
 *   (case-insensitive) before any copying. ALL artifacts sharing the
 *   duplicated subpath are skipped.
 *
 * Each artifact's source path is checked with `test -e` before copying; missing
 * artifacts are silently skipped (the spec distinguishes "never produced" from
 * "produced but lost").
 */
export function extract_conversation(
    container_name: string,
    provider: Tool_Provider,
    patchlab_id: string,
    session_number: number
): Artifact_Extraction_Result {
    const artifacts_root = build_session_path(
        patchlab_id,
        session_number,
        ARCHIVE_ARTIFACTS_DIRECTORY
    );
    const extracted: string[] = [];
    const produced_but_failed: string[] = [];
    const skipped_invalid: string[] = [];

    const artifacts = provider.get_extractable_artifacts();
    if (artifacts.length === 0) {
        return { extracted, produced_but_failed, skipped_invalid };
    }

    const duplicate_skip_set = collect_duplicate_subpath_names(
        artifacts,
        provider.name,
        skipped_invalid
    );

    const state: Extraction_State = {
        extracted,
        produced_but_failed,
        skipped_invalid,
        fence_created: false,
    };
    for (const artifact of artifacts) {
        extract_one_artifact(container_name, provider, artifact, artifacts_root, duplicate_skip_set, state);
    }

    return { extracted, produced_but_failed, skipped_invalid };
}

/** Mutable accumulator threaded through the per-artifact extraction loop. */
interface Extraction_State {
    extracted: string[];
    produced_but_failed: string[];
    skipped_invalid: string[];
    /** The `artifacts/` fence is created lazily on the first successful copy. */
    fence_created: boolean;
}

/**
 * Probe the container for one artifact. Returns true when present, false when
 * absent. On a podman/exec failure the artifact is recorded as
 * `produced_but_failed` — we cannot prove it was never produced, so we treat the
 * unknowable result as potential data loss rather than a silent skip — and
 * false is returned so the caller does not attempt the copy.
 */
function artifact_is_present(
    container_name: string,
    artifact: Extractable_Artifact,
    produced_but_failed: string[],
): boolean {
    try {
        return container_path_exists(container_name, artifact.container_path);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(
            `Warning: could not probe for ${artifact.name} in the container — ${message}; `
            + `recording as produced-but-failed to avoid silently dropping it.`
        );
        produced_but_failed.push(artifact.name);
        return false;
    }
}

/**
 * Extract ONE declared artifact: skip duplicates / invalid subpaths / absent
 * sources, copy the source out to its archive subpath, and validate the written
 * type. Records into `state`'s `extracted` / `produced_but_failed` /
 * `skipped_invalid` lists per outcome. Extracted from `extract_conversation` to
 * keep that orchestrator's cognitive complexity inside the threshold.
 */
function extract_one_artifact(
    container_name: string,
    provider: Tool_Provider,
    artifact: Extractable_Artifact,
    artifacts_root: string,
    duplicate_skip_set: Set<string>,
    state: Extraction_State,
): void {
    if (duplicate_skip_set.has(artifact.name)) {
        return;
    }
    if (!is_archive_subpath_valid(artifact, provider.name, state.skipped_invalid)) {
        return;
    }
    if (!artifact_is_present(container_name, artifact, state.produced_but_failed)) {
        return;
    }

    const destination = path.join(artifacts_root, artifact.archive_subpath);
    try {
        if (!state.fence_created) {
            fs.mkdirSync(artifacts_root, { recursive: true });
            state.fence_created = true;
        }
        copy_from_container(container_name, artifact.container_path, destination);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: failed to extract ${artifact.name} — ${message}`);
        state.produced_but_failed.push(artifact.name);
        return;
    }

    if (!post_write_type_matches(destination, artifact, provider.name, state.skipped_invalid)) {
        return;
    }

    state.extracted.push(artifact.name);
}

/**
 * Backwards-compatible alias for the renamed result interface. Retained as a
 * type alias only — no new code should reference the old name.
 *
 * @deprecated Prefer `Artifact_Extraction_Result`.
 */
export type Conversation_Extraction_Result = Artifact_Extraction_Result;

function collect_duplicate_subpath_names(
    artifacts: readonly Extractable_Artifact[],
    provider_name: string,
    skipped_invalid: string[]
): Set<string> {
    try {
        assert_unique_archive_subpaths(artifacts, provider_name);
        return new Set();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: ${message}`);
    }

    const counts = new Map<string, string[]>();
    for (const artifact of artifacts) {
        const key = artifact.archive_subpath.toLowerCase();
        const names = counts.get(key);
        if (names) {
            names.push(artifact.name);
        } else {
            counts.set(key, [artifact.name]);
        }
    }

    const skip_set = new Set<string>();
    for (const names of counts.values()) {
        if (names.length > 1) {
            for (const name of names) {
                skip_set.add(name);
                skipped_invalid.push(name);
            }
        }
    }
    return skip_set;
}

function is_archive_subpath_valid(
    artifact: Extractable_Artifact,
    provider_name: string,
    skipped_invalid: string[]
): boolean {
    try {
        validate_archive_subpath(artifact.archive_subpath, provider_name);
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: skipping artifact "${artifact.name}" — ${message}`);
        skipped_invalid.push(artifact.name);
        return false;
    }
}

function post_write_type_matches(
    destination: string,
    artifact: Extractable_Artifact,
    provider_name: string,
    skipped_invalid: string[]
): boolean {
    const result = assert_artifact_filesystem_type(
        destination,
        artifact.type,
        provider_name,
        artifact.name
    );
    if (result.kind === 'present') {
        return true;
    }
    if (result.kind === 'absent') {
        // Successful copy followed by an immediate ENOENT means the destination
        // was concurrently removed; treat as type-mismatch for accounting.
        // rmSync is a no-op here (destination is already gone) but keeps the
        // two branches structurally parallel.
        logger().warn(
            `Warning: post-write check for "${artifact.name}" found the destination missing — `
            + `not advertising as extracted.`
        );
        fs.rmSync(destination, { recursive: true, force: true });
        skipped_invalid.push(artifact.name);
        return false;
    }
    // The copy landed as the wrong filesystem type (e.g. a symlink when a
    // regular file was expected). Remove the rejected copy so the archive
    // does not contain exactly the object the check decided not to trust.
    logger().warn(
        `Warning: post-write type check for "${artifact.name}" expected ${artifact.type} `
        + `but found ${result.actual} at ${destination}; not advertising as extracted.`
    );
    fs.rmSync(destination, { recursive: true, force: true });
    skipped_invalid.push(artifact.name);
    return false;
}

/**
 * Test whether `container_path` exists in the container. A MISSING path returns
 * `false` via a normal exit-0 probe (`absent` marker); only a genuine
 * podman/exec failure (container gone, daemon down) throws. The old form ran
 * `test -e` directly, so podman errors and a legitimately-absent path both
 * surfaced as the same thrown error — letting an exec failure masquerade as
 * "artifact never produced" and silently drop a produced artifact. Keeping the
 * two distinct lets callers classify an unknowable result as produced-but-failed
 * rather than absent.
 */
function container_path_exists(container_name: string, container_path: string): boolean {
    const probe = exec_container(
        container_name,
        ['sh', '-c', 'if [ -e "$1" ]; then printf present; else printf absent; fi', 'sh', container_path],
    );
    return probe.trim() === 'present';
}

/**
 * Update session metadata's `status` and (when completed) `completed_at` via
 * read-modify-write, preserving every other field populated at session creation
 * or during the branch commit.
 *
 * `interrupted` leaves `completed_at` as null per the patchlab-archive spec.
 */
export function finalize_session_metadata(
    patchlab_id: string,
    session_number: number,
    status: 'completed' | 'interrupted'
): void {
    const existing = read_session_metadata(patchlab_id, session_number);
    if (!existing) {
        logger().warn(`Warning: session metadata missing for ${patchlab_id}/session-${session_number} — status update skipped.`);
        return;
    }

    existing.status = status;
    if (status === 'completed') {
        existing.completed_at = new Date().toISOString();
    }

    write_session_metadata(patchlab_id, session_number, existing);
}