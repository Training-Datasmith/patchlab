/**
 * Context-bundle injection for sandbox create and resume. Two public entry
 * points:
 *
 *   - `inject_context_bundle` — write `--context` paths into the session's
 *     `context/` archive directory, then copy that directory into the new
 *     container's `$HOME/context/`. Used during `create_sandbox`.
 *   - `inject_resume_context` — merge the previous session's archived context
 *     with any new `--context` inputs supplied at resume time, materialize
 *     the merged set into the new session's `context/`, and copy it into the
 *     resumed container. Used during `resume_sandbox`.
 *
 * Two internal helpers (`find_most_recent_context_directory`,
 * `write_resolved_entries`) and one recursive copy helper
 * (`copy_directory_recursive`) round out the cluster. Pure functions — no
 * module-level state.
 *
 * Extracted from `src/sandbox/provisioning.ts` (cluster 5 of the 2370-line file). The two
 * entry points are called only from `provision_new_sandbox` and
 * `provision_resumed_sandbox`; no other consumer in `src/` or `test/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    copy_context_to_archive,
    copy_context_to_container,
    merge_resume_context,
    resolve_context_paths,
    type Resolved_Context_Entry,
} from '../context.js';
import { build_session_path } from '../archive.js';
import { stage_symlink_within_root } from '../symlink_compatibility.js';
import { logger } from '../logger.js';

/**
 * Resolve `--context` paths, write them into the session's `context/` archive directory,
 * then copy that archive directory into the new container's `$HOME/context/`.
 */
export function inject_context_bundle(
    patchlab_id: string,
    session_number: number,
    container_name: string,
    image_home: string,
    context_paths: string[]
): void {
    const resolution = resolve_context_paths(context_paths);
    for (const warning of resolution.warnings) {
        logger().warn(`Warning: ${warning}`);
    }

    if (resolution.entries.length === 0) {
        return;
    }
    copy_context_to_archive(resolution.entries, patchlab_id, session_number);

    const archive_context_directory = build_session_path(patchlab_id, session_number, 'context');
    copy_context_to_container(container_name, image_home, archive_context_directory);
}

/**
 * Build the merged context for a resumed session by combining the previous session's
 * archived context with any `--context` inputs supplied at resume time. The merged set
 * is materialized as files in the new session's `context/` and copied into the
 * container's `$HOME/context/`.
 */
export function inject_resume_context(
    patchlab_id: string,
    new_session_number: number,
    previous_session_number: number,
    container_name: string,
    image_home: string,
    new_context_paths: string[]
): void {
    // Walk back from the immediate prior session through earlier sessions to find the
    // most recent one with a populated `context/`. Older patchlabs may have intermediate
    // sessions that produced no context (e.g., the user only supplied --context on the
    // initial create); those should not erase the original context for the resumed sandbox.
    const previous_directory = find_most_recent_context_directory(
        patchlab_id,
        previous_session_number
    );
    const merge_result = merge_resume_context(
        previous_directory,
        new_context_paths
    );
    for (const warning of merge_result.warnings) {
        logger().warn(`Warning: ${warning}`);
    }

    if (merge_result.entries.length === 0) {
        return;
    }

    // Materialize merged entries: each `Resolved_Context_Entry`'s source_path is on the host
    // (either the previous session's archive directory or a path from the user's --context).
    const new_session_archive = build_session_path(patchlab_id, new_session_number, 'context');
    fs.mkdirSync(new_session_archive, { recursive: true });
    write_resolved_entries(merge_result.entries, new_session_archive);

    copy_context_to_container(container_name, image_home, new_session_archive);
}

/**
 * Walk backward from `latest_session_number` through earlier sessions and return the
 * first `sessions/{n}/context/` directory that exists and is non-empty. Returns null
 * when no session in the patchlab has populated context.
 *
 * Resume semantics: the resumed sandbox's context should reflect the most recent
 * non-empty context the patchlab has carried — even if the immediate prior session
 * happened to produce nothing (e.g., a session created without `--context` between
 * two that did supply it).
 */
function find_most_recent_context_directory(
    patchlab_id: string,
    latest_session_number: number
): string | null {
    for (let session = latest_session_number; session >= 1; session--) {
        const candidate = build_session_path(patchlab_id, session, 'context');
        if (!fs.existsSync(candidate)) {
            continue;
        }

        if (fs.readdirSync(candidate).length > 0) {
            return candidate;
        }
    }

    return null;
}

function write_resolved_entries(
    entries: Resolved_Context_Entry[],
    destination_root: string
): void {
    for (const entry of entries) {
        const destination = path.join(destination_root, entry.archive_relative_path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const stat = fs.lstatSync(entry.source_path);
        if (stat.isDirectory()) {
            copy_directory_recursive(entry.source_path, destination, entry.source_path);
            continue;
        }

        if (stat.isSymbolicLink()) {
            try {
                fs.unlinkSync(destination);
            } catch (error) {
                // ENOENT means there was nothing at `destination` to clear out
                // before the symlink write — the happy path. Any other code
                // (EACCES, EBUSY, EISDIR, EPERM) would block the symlink write
                // that follows, so surface it now with the precise error
                // instead of letting the downstream call fail with a vaguer one.
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            // A top-level context symlink is contained against its own parent
            // directory: an absolute target or a `..` climb out of that parent is
            // refused rather than replicated into the container's $HOME/context/.
            stage_symlink_within_root(
                entry.source_path,
                destination,
                path.dirname(entry.source_path),
                entry.archive_relative_path,
            );
            continue;
        }

        fs.copyFileSync(entry.source_path, destination);
        fs.chmodSync(destination, stat.mode);
    }
}

function copy_directory_recursive(
    source: string,
    destination: string,
    containing_root: string,
): void {
    fs.mkdirSync(destination, { recursive: true });
    for (const child of fs.readdirSync(source, { withFileTypes: true })) {
        const child_source = path.join(source, child.name);
        const child_destination = path.join(destination, child.name);
        if (child.isDirectory()) {
            copy_directory_recursive(child_source, child_destination, containing_root);
        } else if (child.isSymbolicLink()) {
            // Nested links are contained against the top-level entry directory,
            // threaded unchanged through the recursion — a link anywhere in the
            // tree may not escape the directory the user supplied as context.
            stage_symlink_within_root(child_source, child_destination, containing_root, child.name);
        } else {
            fs.copyFileSync(child_source, child_destination);
            const stat = fs.lstatSync(child_source);
            fs.chmodSync(child_destination, stat.mode);
        }
    }
}
