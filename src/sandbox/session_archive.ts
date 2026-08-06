/**
 * Session-archive lifecycle helpers for create, resume, and inspect.
 *
 *   - **Create-path entry** (`write_initial_session_metadata`) — claim the
 *     next free `sessions/{n}/` directory, write the initial `metadata.json`,
 *     return the claimed session number. Composes `claim_session_directory`.
 *   - **Inspect-path entry** (`read_session_summaries`) — walk every numbered
 *     session directory under a sandbox, read each `metadata.json`, and
 *     project per-repository extraction outcomes into the shape the inspect
 *     view consumes.
 *   - **Resume-path entry** (`check_required_for_resume`) — three-layer guard
 *     verifying the prior session's archive is suitable for resume (status
 *     precheck → sentinel pass → required-presence pass). Composes the two
 *     local helpers `has_artifact_been_populated` and `is_artifact_populated`.
 *
 * Owns the public-facing per-session value shape `Session_Summary` (re-exported
 * through `./index.js` for the library surface) because `read_session_summaries`
 * is its sole producer; `inspect.ts` re-imports it as type-only for the
 * `Sandbox_Details.sessions` field. `Session_Repository_Outcome` is the
 * inner per-repository row shape used by `Session_Summary.repositories[]`; it
 * stays internal to the sandbox subsystem — consumers read it structurally
 * through `Session_Summary` rather than by name.
 *
 * Tests: [test/unit/resume-guards.test.ts](../../test/unit/resume-guards.test.ts)
 * imports `check_required_for_resume` via `src/sandbox/index.ts`'s re-export.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    ARCHIVE_ARTIFACTS_DIRECTORY,
    build_archive_path,
    build_session_path,
    next_session_number,
    read_session_metadata,
    write_session_metadata,
} from '../archive.js';
import {
    assert_artifact_filesystem_type,
    assert_unique_archive_subpaths,
    validate_archive_subpath,
    type Extractable_Artifact,
    type Filesystem_Type_Check_Result,
} from '../extractable_artifact.js';
import { make_initial_session_metadata } from '../branch/index.js';
import {
    manifest_repositories,
    type Sandbox_Manifest,
} from '../manifest.js';
import {
    resolve_resource_limits,
    resolved_limits_to_persisted,
    persisted_resource_limits_to_on_disk,
} from '../resource_limits.js';
import { get_provider } from '../tools/index.js';
import { logger } from '../logger.js';

/**
 * Per-session per-repository extraction outcome surfaced by `patchlab inspect`.
 * For single-repository patchlabs each session block has one entry; for multi-repository
 * patchlabs it has one entry per repository in `manifest_repositories(manifest)`.
 */
export interface Session_Repository_Outcome {
    repository_root: string;
    commit_sha: string | null;
    fallback_patch_path: string | null;
}

export interface Session_Summary {
    session_number: number;
    created_at: string;
    completed_at: string | null;
    status: 'completed' | 'interrupted';
    /**
     * Per-repository outcomes. Length matches `manifest_repositories(manifest).length`.
     * For single-repository patchlabs the array has one entry, allowing the CLI to
     * render the legacy single-line display.
     */
    repositories: Session_Repository_Outcome[];
    /**
     * True when the session has BOTH a non-null `commit_sha` for some repository AND
     * a non-null `fallback_patch_path` for another repository — a mixed multi-repository
     * outcome. Always false for single-repository patchlabs.
     */
    partial_success: boolean;
}

/** Default bound on claim attempts before `claim_session_number_from` gives up. */
const SESSION_CLAIM_ATTEMPT_LIMIT = 1024;

/**
 * Claim the next free `sessions/{n}/` directory by trying mkdir with `exclusive`
 * semantics in a bounded loop. Races between two concurrent create/resume calls
 * resolve cleanly: the loser sees EEXIST and increments.
 */
export function claim_session_directory(patchlab_id: string): number {
    const sessions_root = path.join(build_archive_path(patchlab_id), 'sessions');
    fs.mkdirSync(sessions_root, { recursive: true });

    return claim_session_number_from(patchlab_id, next_session_number(patchlab_id));
}

/**
 * The bounded exclusive-mkdir loop behind `claim_session_directory`, with the
 * starting candidate and attempt limit injected so the race-resolution branch
 * (EEXIST → increment) and the exhaustion ceiling are reachable from a
 * single-threaded test. Production always enters via `claim_session_directory`,
 * which derives `starting_candidate` from `next_session_number` — a value that
 * is free by construction, so the EEXIST branch never fires on the first
 * attempt there.
 *
 * `starting_candidate` models the session number a caller read before a
 * concurrent winner may have claimed it: each candidate is created with
 * `recursive: false`, so an already-claimed number throws EEXIST and the loop
 * advances to the next. Any non-EEXIST error (e.g. EACCES) is fatal and
 * rethrown unchanged.
 */
export function claim_session_number_from(
    patchlab_id: string,
    starting_candidate: number,
    attempt_limit: number = SESSION_CLAIM_ATTEMPT_LIMIT,
): number {
    let candidate = starting_candidate;
    const ceiling = starting_candidate + attempt_limit;
    while (candidate < ceiling) {
        const session_directory = build_session_path(patchlab_id, candidate);
        try {
            fs.mkdirSync(session_directory, { recursive: false });
            return candidate;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') {
                throw error;
            }
            candidate++;
        }
    }
    throw new Error(
        `Could not claim a session directory for patchlab ${patchlab_id} `
        + `after ${attempt_limit} attempts (starting from session ${starting_candidate}).`
    );
}

/**
 * Claim the next free `sessions/{n}/` directory and write the initial
 * `metadata.json` for that session. Called once by `create_sandbox` (session 1)
 * and again by `resume_sandbox` (session N>1). Returns the claimed session
 * number so the caller can drive downstream artifact extraction against it.
 */
export function write_initial_session_metadata(
    patchlab_id: string,
    tool_name: string,
    container_name: string,
    manifest: Sandbox_Manifest,
    resolved_limits: ReturnType<typeof resolve_resource_limits>,
): number {
    const session_number = claim_session_directory(patchlab_id);
    const initial_metadata = make_initial_session_metadata(
        session_number,
        tool_name,
        container_name,
        manifest_repositories(manifest),
    );
    initial_metadata.resource_limits = persisted_resource_limits_to_on_disk(
        resolved_limits_to_persisted(resolved_limits),
    );
    write_session_metadata(patchlab_id, session_number, initial_metadata);
    return session_number;
}

/**
 * Walk every `sessions/{n}/` directory in numeric order, read each
 * `metadata.json`, and project per-repository extraction outcomes into the
 * `Session_Summary` shape consumed by `inspect_sandbox`. Sessions with no
 * readable metadata are silently skipped (e.g., crashed mid-claim).
 */
export function read_session_summaries(
    patchlab_id: string,
    repositories: string[],
): Session_Summary[] {
    const sessions_directory = path.join(build_archive_path(patchlab_id), 'sessions');
    if (!fs.existsSync(sessions_directory)) {
        return [];
    }

    // Filter by string shape BEFORE `Number()` coercion: `Number('1e2')` is 100
    // and `Number.isInteger(100)` is true, so a malformed `sessions/1e2/` entry
    // would otherwise be accepted (and order sessions wrong). The writer only
    // produces decimal-integer names with no leading zero, so the regex is the
    // tightest contract that matches what we ever write.
    const session_numbers = fs
        .readdirSync(sessions_directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
        .map((entry) => Number(entry.name))
        .sort((a, b) => a - b);
    const summaries: Session_Summary[] = [];
    for (const session_number of session_numbers) {
        const metadata = read_session_metadata(patchlab_id, session_number);
        if (metadata === null) {
            continue;
        }
        const per_repository: Session_Repository_Outcome[] = repositories.map((repository_root) => ({
            repository_root,
            commit_sha: metadata.commit_shas[repository_root] ?? null,
            fallback_patch_path: metadata.fallback_patches[repository_root] ?? null,
        }));
        const has_committed_repository = per_repository.some((entry) => entry.commit_sha !== null);
        // A "pure-fallback" repository carries a fallback patch but no commit. The
        // partial-success marker only triggers when at least one repository committed
        // AND a DIFFERENT repository fell back. Checking pure-fallback (rather than
        // any fallback) prevents a false positive if a future code path ever
        // produces both fields on a single repository.
        const has_pure_fallback_repository = per_repository.some((entry) =>
            entry.commit_sha === null && entry.fallback_patch_path !== null
        );
        summaries.push({
            session_number: metadata.session_number,
            created_at: metadata.created_at,
            completed_at: metadata.completed_at,
            status: metadata.status,
            repositories: per_repository,
            partial_success: has_committed_repository && has_pure_fallback_repository,
        });
    }
    return summaries;
}

/**
 * Verify the prior session's archive is suitable for resume.
 *
 * The check runs in three layers:
 *
 *   1. SENTINEL PASS — delegated to `has_artifact_been_populated`. Iterates
 *      ALL declared artifacts (no `required_for_resume` filter) and asks
 *      `is_artifact_populated`. If ANY artifact returns `'populated'`, the
 *      tool was used and resume must verify required artifacts. If NONE
 *      return `'populated'`, the tool was never used and absent-by-design
 *      required artifacts do not block resume — return. Type mismatches are
 *      handled asymmetrically inside the helper: REQUIRED + mismatch fails
 *      fast; OPTIONAL + mismatch logs a warning and is treated as `'absent'`
 *      so an optional misshape can never become a denial-of-resume vector.
 *
 *   2. STATUS CHECK. Read prior session metadata; refuse resume if its
 *      `status` is `'interrupted'`. This guards against the partial-extraction
 *      corner case where extraction crashed mid-loop and left some artifacts
 *      populated and others missing. The check fires ONLY after the sentinel
 *      confirms artifacts exist — a session that produced no artifacts cannot
 *      have partial extraction, so an interrupted status on such a session
 *      does not block resume.
 *
 *   3. REQUIRED-PRESENCE PASS. With the sentinel signal `true`, iterate only
 *      `required_for_resume` artifacts; collect any whose result is anything
 *      other than `'populated'` and throw naming the missing entries.
 */
export function check_required_for_resume(
    patchlab_id: string,
    previous_session_number: number,
    provider: ReturnType<typeof get_provider>
): void {
    const artifacts = provider.get_extractable_artifacts();
    if (artifacts.length === 0) {
        return;
    }

    // Host-boundary checks on the declared artifact array. Uniqueness first
    // (array-level — its error names every conflicting entry, the most
    // actionable diagnostic), then per-artifact validation. Both raise
    // immediately; the resume check is fail-fast on these.
    assert_unique_archive_subpaths(artifacts, provider.name);
    for (const artifact of artifacts) {
        validate_archive_subpath(artifact.archive_subpath, provider.name);
    }

    const artifacts_root = build_session_path(
        patchlab_id,
        previous_session_number,
        ARCHIVE_ARTIFACTS_DIRECTORY
    );

    if (!has_artifact_been_populated(artifacts, artifacts_root, provider, previous_session_number)) {
        return;
    }

    const previous_metadata = read_session_metadata(patchlab_id, previous_session_number);
    if (previous_metadata?.status === 'interrupted') {
        throw new Error(
            `Resume cannot proceed: session ${previous_session_number} ended with status `
            + `"interrupted" (extraction did not complete). Required artifacts may be `
            + `missing or partial. To force resume despite this, edit `
            + `~/.patchlab/${patchlab_id}/sessions/${previous_session_number}/metadata.json `
            + `to set status to "completed".`
        );
    }

    // Required-presence pass: every required artifact must be populated.
    const missing: string[] = [];
    for (const artifact of artifacts) {
        if (!artifact.required_for_resume) {
            continue;
        }

        const result = is_artifact_populated(artifact, artifacts_root, provider.name);
        if (result.kind !== 'populated') {
            missing.push(artifact.name);
        }
    }

    if (missing.length > 0) {
        throw new Error(
            `Resume cannot proceed: required artifact(s) missing from session ${previous_session_number}: `
            + `${missing.join(', ')}. The prior session produced data but the listed `
            + `artifacts were not extracted to the archive.`
        );
    }
}

function has_artifact_been_populated(
    artifacts: Extractable_Artifact[],
    artifacts_root: string,
    provider: ReturnType<typeof get_provider>,
    previous_session_number: number
): boolean {
    // Sentinel pass: did the tool produce any artifact? Required mismatches
    // fail fast here; optional mismatches warn and are treated as absent.
    let used = false;
    for (const artifact of artifacts) {
        const result = is_artifact_populated(artifact, artifacts_root, provider.name);
        if (result.kind === 'populated') {
            used = true;
            continue;
        }

        if (result.kind === 'mismatch') {
            if (artifact.required_for_resume) {
                throw new Error(
                    `Resume cannot proceed: required artifact "${artifact.name}" `
                    + `(provider "${provider.name}") declared type ${artifact.type} but `
                    + `the on-disk entry at sessions/${previous_session_number}/`
                    + `${ARCHIVE_ARTIFACTS_DIRECTORY}/${artifact.archive_subpath} is `
                    + `${result.actual}. Refusing to inject a mismatched artifact.`
                );
            }

            logger().warn(
                `Warning: optional artifact "${artifact.name}" (provider "${provider.name}") `
                + `declared type ${artifact.type} but on-disk entry is ${result.actual}; `
                + `treating as absent and continuing.`
            );
        }
    }

    return used;
}

type Populated_Check_Result =
    | { kind: 'populated' }
    | { kind: 'absent' }
    | { kind: 'mismatch'; actual: string };

function is_artifact_populated(
    artifact: Extractable_Artifact,
    artifacts_root: string,
    provider_name: string
): Populated_Check_Result {
    const artifact_path = path.join(artifacts_root, artifact.archive_subpath);
    const result: Filesystem_Type_Check_Result = assert_artifact_filesystem_type(
        artifact_path,
        artifact.type,
        provider_name,
        artifact.name
    );

    // Empty directories and 0-byte files BOTH count as populated. The mkdir
    // for the destination is performed by `podman cp` itself, not by an
    // unconditional `mkdirSync` — so an empty destination is unambiguous
    // evidence of a successful empty-source extraction.
    //
    // The exhaustive switch is load-bearing: adding a new `kind` to
    // `Filesystem_Type_Check_Result` without extending this mapping would
    // leave a code path that implicitly falls through to `undefined`, which
    // violates the declared return type and trips a TS error here.
    switch (result.kind) {
        case 'present':
            return { kind: 'populated' };
        case 'absent':
            return { kind: 'absent' };
        case 'mismatch':
            return { kind: 'mismatch', actual: result.actual };
    }
}
