/**
 * Workspace-copies archive and restore — the full lifecycle for files injected
 * via `--copy` that are not tracked by the patchlab branch (primarily gitignored
 * files such as `composer.lock`).
 *
 * Public surface:
 *   - `copy_workspace_copies_to_archive` — snapshot copies into `sessions/n/workspace-copies/`
 *   - `extract_workspace_copies`          — copy-out at session end (best-effort)
 *   - `restore_workspace_copies`          — inject archive into container workspace on resume
 *   - `merge_resume_workspace_copies`     — merge previous session's copies with new --copy inputs
 *
 * The `Copy_Specification` interface is defined here and imported by callers
 * (`workspace_staging.ts`, `provisioning.ts`, `cli_arguments.ts`) to avoid
 * circular dependencies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    copy_from_container,
    copy_to_container,
    exec_container,
} from '../podman.js';
import { copy_path_recursively } from '../context.js';
import { build_session_path } from '../archive.js';
import { host_is_case_insensitive } from '../path_containment.js';
import { logger } from '../logger.js';

/** A single `--copy` entry: a resolved host path and its workspace-root-relative destination. */
export interface Copy_Specification {
    /** Absolute path to the source file or directory on the host. */
    source_path: string;
    /** Destination path relative to the workspace root (no leading slash, no `..`). */
    destination: string;
}

export interface Merge_Resume_Workspace_Copies_Result {
    warnings: string[];
}

/**
 * Archive the contents of each `Copy_Specification` into `sessions/n/workspace-copies/`
 * in the patchlab archive, using the destination path as the archive key. Mirrors
 * `copy_context_to_archive` in `context.ts`.
 */
export function copy_workspace_copies_to_archive(
    copy_paths: Copy_Specification[],
    patchlab_id: string,
    session_number: number,
): void {
    if (copy_paths.length === 0) {
        return;
    }

    const archive_root = build_session_path(patchlab_id, session_number, 'workspace-copies');
    fs.mkdirSync(archive_root, { recursive: true });

    for (const specification of copy_paths) {
        if (!fs.existsSync(specification.source_path)) {
            logger().warn(`Warning: workspace copy source does not exist; skipping: ${specification.source_path}`);
            continue;
        }

        const destination = path.join(archive_root, specification.destination);
        fs.mkdirSync(path.dirname(destination), { recursive: true });

        const containing_root = fs.lstatSync(specification.source_path).isDirectory()
            ? specification.source_path
            : path.dirname(specification.source_path);

        copy_path_recursively(specification.source_path, destination, containing_root);
    }
}

/**
 * At session end, copy the current state of each workspace-copies destination
 * back out of the container into `sessions/n/workspace-copies/`, replacing the
 * archived originals with the current container state. If a destination is
 * absent from the container (the tool deleted it), the archive entry is left
 * unchanged so the file can be restored on the next resume.
 *
 * Destinations are discovered by enumerating `workspace_copies_directory` (the
 * current session's archive, already populated at injection time). No manifest
 * field is needed — the archive directory itself is the record of what to copy.
 *
 * This is best-effort: individual copy failures are logged as warnings and do
 * NOT abort extraction or contribute to `lost_data`.
 */
export function extract_workspace_copies(
    container_name: string,
    image_home: string,
    workspace_copies_directory: string,
): void {
    if (!fs.existsSync(workspace_copies_directory)) {
        return;
    }

    const workspace_root = `${image_home}/workspace`;

    for (const relative_path of list_relative_files(workspace_copies_directory)) {
        const container_path = `${workspace_root}/${relative_path}`;
        const archive_path = path.join(workspace_copies_directory, relative_path);

        try {
            // Check whether the file still exists in the container by listing it.
            // Using exec_container + test -e is more portable than copy_from_container
            // when the file might not exist (copy_from_container would throw).
            exec_container(container_name, ['test', '-e', container_path]);
        } catch {
            // File is absent in the container (deleted by the tool). Leave the
            // archive entry unchanged so it can be restored on the next resume.
            continue;
        }

        try {
            fs.mkdirSync(path.dirname(archive_path), { recursive: true });
            copy_from_container(container_name, container_path, archive_path);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(`Warning: workspace copy-out failed for '${relative_path}' — ${message}. Continuing.`);
        }
    }
}

/**
 * Copy `sessions/n/workspace-copies/` contents into the container workspace,
 * skipping any destination whose forward-slashed path is already in
 * `branch_file_set` (branch tip is authoritative for those; non-gitignored
 * copies that the tool modified survive via the branch tip and must not be
 * clobbered). Mirrors `copy_context_to_container` in `context.ts`.
 */
export function restore_workspace_copies(
    container_name: string,
    image_home: string,
    archive_copies_directory: string,
    branch_file_set: Set<string>,
): void {
    if (!fs.existsSync(archive_copies_directory)) {
        return;
    }

    const relative_files = list_relative_files(archive_copies_directory);
    if (relative_files.length === 0) {
        return;
    }

    const workspace_root = `${image_home}/workspace`;

    for (const relative_path of relative_files) {
        // Destinations are workspace-root-relative with forward slashes — they
        // match branch-file-set keys directly (no mount prefix conversion needed).
        const normalized = relative_path.replaceAll('\\', '/');
        if (branch_file_set.has(normalized)) {
            continue;
        }

        const archive_path = path.join(archive_copies_directory, relative_path);
        const container_path = `${workspace_root}/${normalized}`;
        const container_parent = `${workspace_root}/${path.posix.dirname(normalized)}`;

        exec_container(container_name, ['mkdir', '-p', container_parent]);
        copy_to_container(container_name, archive_path, container_path);
    }
}

/**
 * Build the merged workspace-copies set for a new session by combining the
 * previous session's archived copies with new `--copy` inputs. New inputs win
 * on destination conflict (same as `--context` behavior). The re-archive-every-
 * session invariant is upheld: the full resolved set is always written to
 * `sessions/n/workspace-copies/` even when `new_copy_paths` is empty, so a
 * single-step look-back is sufficient across arbitrarily many resumes.
 */
export function merge_resume_workspace_copies(
    previous_session_copies_directory: string | null,
    new_copy_paths: Copy_Specification[],
    patchlab_id: string,
    session_number: number,
): Merge_Resume_Workspace_Copies_Result {
    const warnings: string[] = [];

    // Build a set of destinations claimed by new inputs for conflict detection.
    const claimed_by_new = new Set(
        new_copy_paths.map((specification) => conflict_key(specification.destination))
    );

    const archive_root = build_session_path(patchlab_id, session_number, 'workspace-copies');
    fs.mkdirSync(archive_root, { recursive: true });

    // Carry forward previous session's copies that don't conflict with new inputs.
    if (previous_session_copies_directory && fs.existsSync(previous_session_copies_directory)) {
        for (const relative_path of list_relative_files(previous_session_copies_directory)) {
            if (claimed_by_new.has(conflict_key(relative_path))) {
                warnings.push(
                    `Workspace copy override: '${relative_path}' from previous session is replaced by --copy input.`
                );
                continue;
            }

            const source = path.join(previous_session_copies_directory, relative_path);
            const destination = path.join(archive_root, relative_path);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(source, destination);
        }
    }

    // Archive new copy specs (copy from host to archive).
    for (const specification of new_copy_paths) {
        if (!fs.existsSync(specification.source_path)) {
            warnings.push(
                `Warning: workspace copy source does not exist; skipping: ${specification.source_path}`
            );
            continue;
        }

        const destination = path.join(archive_root, specification.destination);
        fs.mkdirSync(path.dirname(destination), { recursive: true });

        const containing_root = fs.lstatSync(specification.source_path).isDirectory()
            ? specification.source_path
            : path.dirname(specification.source_path);

        copy_path_recursively(specification.source_path, destination, containing_root);
    }

    return { warnings };
}

function conflict_key(destination: string): string {
    const normalized = destination.replaceAll('\\', '/');
    return host_is_case_insensitive() ? normalized.toLowerCase() : normalized;
}

function list_relative_files(root: string): string[] {
    const results: string[] = [];
    walk_directory(root, '', results);
    return results;
}

function walk_directory(root: string, prefix: string, accumulator: string[]): void {
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
        const next = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            walk_directory(root, next, accumulator);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            accumulator.push(next);
        }
    }
}
