/**
 * Inspect surface for the sandbox package — every read-only diagnostic that
 * walks `~/.patchlab/{id}/manifest.json` (and, for `inspect_sandbox`, the
 * per-repository branch tips and the per-session metadata) lives here.
 *
 *   - `get_working_directory(sandbox_id)` — the path inside the container.
 *     Resolves via the provider's `image_specification.image_home`, falling
 *     back to `CONTAINER_WORKING_DIR` when the manifest or provider cannot
 *     be loaded.
 *   - `list_sandboxes()` — one `Sandbox_Info` per readable `~/.patchlab/*`
 *     directory; invalid directories are silently skipped.
 *   - `inspect_sandbox(sandbox_id)` — full `Sandbox_Details` including
 *     per-repository branch state and `Session_Summary` list (the latter
 *     delegated to `read_session_summaries`).
 *
 * Owns the three inspect-shape types (`Sandbox_Info`,
 * `Repository_Branch_State`, `Sandbox_Details`). The session-summary types
 * are re-imported from `./session_archive.js` (their producer) for the
 * `Sandbox_Details.sessions` field. All five surface via
 * `src/sandbox/index.ts`.
 *
 * Extracted from `src/sandbox/provisioning.ts`. No module-level state; one runtime call
 * out to `./session_archive.js` for the per-session walk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    build_archives_root,
    build_archive_path,
} from '../archive.js';
import {
    manifest_primary_source,
    manifest_repositories,
    read_manifest,
    resolve_manifest_tool,
    type Source_Specification,
} from '../manifest.js';
import {
    CONTAINER_WORKING_DIR,
    container_exists,
    container_running,
} from '../podman.js';
import {
    patchlab_branch_exists,
    patchlab_branch_name,
} from '../branch/index.js';
import { compute_container_workspace_path, get_provider, register_per_source_manifests } from '../tools/index.js';
import {
    read_session_summaries,
    type Session_Summary,
} from './session_archive.js';

export interface Sandbox_Info {
    id: string;
    /**
     * Primary source's host path — `manifest.sources[0].host_path`. Kept as a
     * single string for CLI back-compat with the legacy single-source list
     * view; multi-source patchlabs surface the additional entries through
     * `additional_source_count` and the full enumeration in `inspect_sandbox`.
     */
    source_path: string;
    /**
     * Number of sources beyond the primary (i.e. `manifest.sources.length - 1`).
     * `0` for any single-source patchlab. Renders as the `(+N more)` indicator
     * in `patchlab list` without requiring a second manifest read.
     */
    additional_source_count: number;
    created_at: string;
    container_name: string;
    container_status: 'running' | 'stopped' | 'missing';
    tool?: string;
}

/**
 * Per-repository branch state surfaced by `patchlab inspect` for multi-repository
 * patchlabs (and single-entry under the single-repository case). The order of the
 * `repositories` array in `Sandbox_Details` matches
 * `manifest_repositories(manifest)`'s first-appearance order.
 */
export interface Repository_Branch_State {
    /** `manifest_repositories(manifest)` entry — byte-for-byte from the manifest. */
    repository_root: string;
    /** Branch tip SHA on `patchlab/{id}`, or `null` when the branch is missing. */
    branch_tip: string | null;
    /** True when `patchlab/{id}` exists in this repository, false otherwise. */
    branch_exists: boolean;
}

// Per-session value shapes are owned by `./session_archive.js` (their sole producer).
// Re-imported here as types because `Sandbox_Details.sessions` carries them.

export interface Sandbox_Details extends Sandbox_Info {
    container_image: string;
    container_working_dir: string;
    tool?: string;
    include_globs?: string[];
    exclude_globs?: string[];
    /**
     * Per-repository branch state for every distinct repository the patchlab spans.
     * For single-repository patchlabs the array has one entry. Order matches
     * `manifest_repositories(manifest)`.
     */
    repositories: Repository_Branch_State[];
    /**
     * Session list with per-repository extraction outcomes. The CLI renders single-
     * repository patchlabs with the legacy single-line per-session display and
     * multi-repository patchlabs with one line per repository per session.
     */
    sessions: Session_Summary[];
    /**
     * Full per-source enumeration (`host_path`, `repository_root`, `source_prefix`,
     * `mount_name`) for the CLI's `inspect` view. Order matches the manifest's
     * `sources` array.
     */
    sources: Source_Specification[];
}

/** Returns the working directory path inside the container for a given sandbox. */
export function get_working_directory(sandbox_id: string): string {
    try {
        const sandbox_directory = build_archive_path(sandbox_id);
        const manifest = read_manifest(sandbox_directory);
        const tool_name = resolve_manifest_tool(manifest);
        const provider = get_provider(tool_name);
        return compute_container_workspace_path(provider);
    } catch (_manifest_or_provider_unavailable) {
        return CONTAINER_WORKING_DIR;
    }
}

export function list_sandboxes(): Sandbox_Info[] {
    const root = build_archives_root();
    if (!fs.existsSync(root)) {
        return [];
    }

    const entries = fs.readdirSync(root, { withFileTypes: true });
    const results: Sandbox_Info[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const sandbox_directory = path.join(root, entry.name);
        try {
            const manifest = read_manifest(sandbox_directory);
            const primary = manifest_primary_source(manifest);
            let status: Sandbox_Info['container_status'] = 'missing';
            if (container_exists(manifest.container_name)) {
                status = container_running(manifest.container_name) ? 'running' : 'stopped';
            }

            results.push({
                id: manifest.id,
                source_path: primary.host_path,
                additional_source_count: manifest.sources.length - 1,
                created_at: manifest.created_at,
                container_name: manifest.container_name,
                container_status: status,
                tool: manifest.tool,
            });
        } catch (_unreadable_sandbox) {
            // Skip invalid sandbox directories
        }
    }

    return results;
}

/** Get full details of a sandbox including container info. */
export function inspect_sandbox(sandbox_id: string): Sandbox_Details {
    const sandbox_directory = build_archive_path(sandbox_id);
    if (!fs.existsSync(sandbox_directory)) {
        throw new Error(`Sandbox not found: ${sandbox_id}`);
    }

    const manifest = read_manifest(sandbox_directory);
    const primary = manifest_primary_source(manifest);
    const repositories_in_manifest = manifest_repositories(manifest);
    let status: Sandbox_Info['container_status'] = 'missing';
    if (container_exists(manifest.container_name)) {
        status = container_running(manifest.container_name) ? 'running' : 'stopped';
    }

    // Register per-source manifests so `get_provider(tool_name)` can resolve
    // configured tools whose names are only defined under
    // `<repository_root>/.patchlab/tools/`. Inspect is a diagnostic —
    // registration only; no trust prompt.
    register_per_source_manifests(repositories_in_manifest);

    const tool_name = resolve_manifest_tool(manifest);
    const provider = get_provider(tool_name);

    // Per-repository branch state for the Repositories section. Each entry resolves
    // `patchlab/{id}`'s tip SHA in that repository if the branch exists.
    const branch = patchlab_branch_name(sandbox_id);
    const repositories: Repository_Branch_State[] = repositories_in_manifest.map((repository_root) => {
        const has_patchlab_branch = patchlab_branch_exists(repository_root, sandbox_id);
        let branch_tip: string | null = null;
        if (has_patchlab_branch) {
            try {
                branch_tip = resolve_ref_tip(repository_root, `refs/heads/${branch}`);
            } catch (_show_ref_failed) {
                branch_tip = null;
            }
        }
        return { repository_root, branch_tip, branch_exists: has_patchlab_branch };
    });

    // Per-session per-repository summaries. The per-repository maps already
    // carry one entry per repository under the schema's populated-null contract.
    const sessions: Session_Summary[] = read_session_summaries(sandbox_id, repositories_in_manifest);

    return {
        id: manifest.id,
        source_path: primary.host_path,
        additional_source_count: manifest.sources.length - 1,
        created_at: manifest.created_at,
        container_name: manifest.container_name,
        container_status: status,
        container_image: manifest.container_image,
        container_working_dir: compute_container_workspace_path(provider),
        tool: tool_name,
        include_globs: manifest.include_globs,
        exclude_globs: manifest.exclude_globs,
        repositories,
        sessions,
        sources: manifest.sources,
    };
}

function resolve_ref_tip(repository_root: string, ref: string): string {
    return execFileSync('git', ['rev-parse', ref], {
        cwd: repository_root,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
    }).trim();
}