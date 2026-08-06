/**
 * Session-metadata helpers used by the create/resume and apply flows.
 *
 * `make_initial_session_metadata` builds the metadata.json that the
 * create-sandbox and resume-sandbox paths write at session start. It is NOT
 * part of the session-exit fan-out (that lives in session_commit.ts); it is
 * the pre-allocation step that gives `record_extraction_outcome` something
 * to read-modify-write later.
 *
 * `list_session_commits` is the lookup the apply flow uses to enumerate a
 * patchlab's session commits for one specific repository_root.
 */
import { read_archive, type Session_Metadata } from '../archive.js';

/**
 * Build the initial session metadata to write when a sandbox starts.
 *
 * `repositories` is the output of `manifest_repositories(manifest)`; it MUST
 * be non-empty (every patchlab spans at least one repository). The produced metadata's
 * `commit_shas` and `fallback_patches` maps are pre-populated with one `null`
 * entry per repository in `repositories`, in the supplied order. The empty-map `{}`
 * shape is reserved for the pre-allocation transient state and SHALL NOT
 * appear in any persisted metadata.
 */
export function make_initial_session_metadata(
    session_number: number,
    tool_name: string,
    container_name: string,
    repositories: string[]
): Session_Metadata {
    if (repositories.length === 0) {
        throw new Error(
            'make_initial_session_metadata: repositories array must be non-empty. '
            + 'Every patchlab spans at least one repository.'
        );
    }

    const commit_shas: Record<string, string | null> = {};
    const fallback_patches: Record<string, string | null> = {};
    for (const repository of repositories) {
        commit_shas[repository] = null;
        fallback_patches[repository] = null;
    }

    return {
        session_number,
        created_at: new Date().toISOString(),
        completed_at: null,
        status: 'interrupted',
        tool: tool_name,
        container_name,
        commit_shas,
        fallback_patches,
        // Filled in by the create/resume path via r-m-w after `podman create`
        // succeeds. Left `null` here so an early failure (before the create
        // call) leaves no misleading limits record.
        resource_limits: null,
    };
}

export interface Session_Commit_Reference {
    session_number: number;
    commit_sha: string;
}

/**
 * List a patchlab's session commits for `repository_root`, ordered by
 * session_number ascending. Sessions whose `commit_shas[repository_root]`
 * entry is null (no code changes for that repository in the session) are
 * excluded; this is silent skip-behavior because empty per-repository
 * sessions are normal in multi-repository patchlabs. The caller's
 * `--repository` flag (or, for single-repository patchlabs, the manifest's
 * only repository) decides which key drives the filter.
 */
export function list_session_commits(
    patchlab_id: string,
    repository_root: string,
): Session_Commit_Reference[] {
    const archive = read_archive(patchlab_id);
    const result: Session_Commit_Reference[] = [];
    for (const session of archive.sessions) {
        const commit_sha = session.commit_shas[repository_root] ?? null;
        if (commit_sha) {
            result.push({
                session_number: session.session_number,
                commit_sha,
            });
        }
    }

    return result;
}
