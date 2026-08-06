/**
 * Public surface of the branch subsystem. Every importer outside `src/branch/`
 * sources symbols from here (`./branch/index.js`); the sibling modules in this
 * directory are internal implementation.
 *
 * One re-export block per sibling file, in the rough order a session moves
 * through them: naming first (used by every other file), then predicates,
 * then the lifecycle entries (create / session-commit / delete / apply),
 * then the read-only diff helpers and session-metadata utilities.
 *
 * `archive.ts` carries the `git archive` tar-streaming flow used by resume's
 * branch-tip export; it is grouped under this directory for cohesion but
 * holds its own concerns and its own consumers.
 */

export {
    PATCHLAB_BRANCH_PREFIX,
    patchlab_branch_name,
    patchlab_id_from_branch_name,
} from './naming.js';

export {
    branch_exists,
    detect_submodules,
    is_git_repository,
    is_working_tree_dirty,
    patchlab_branch_exists,
    resolve_repository_root,
} from './predicates.js';

export {
    type Create_Branch_Options,
    type Create_Branch_Result,
    create_patchlab_branch,
    make_temporary_index_path,
} from './create.js';

export {
    DEFAULT_MAX_DIFF_BYTES,
    type Commit_Session_Options,
    type Commit_Session_Result,
    commit_session_to_branch,
    disambiguate_repository_basenames,
    record_extraction_outcome,
} from './session_commit.js';

export {
    make_initial_session_metadata,
    list_session_commits,
    type Session_Commit_Reference,
} from './session_metadata.js';

export {
    type Delete_Branch_Outcome,
    type Delete_Branch_Options,
    delete_patchlab_branch,
    unapplied_session_commits,
} from './delete.js';

export {
    type Apply_Mode,
    type Apply_Options,
    type Applied_Item,
    type Skipped_Item,
    type Apply_Conflict,
    type Apply_Result,
    apply_patchlab_branch,
    resolve_apply_repository,
} from './apply.js';

export {
    read_cumulative_diff,
    resolve_diff_start_reference,
    compose_diff_against_baseline_with_pending,
    read_commit_diff,
    list_branch_files,
} from './diff_read.js';

export {
    DEFAULT_MAX_ARCHIVE_BYTES,
    export_branch_tip,
    export_per_source_branch_tip_to_container,
    is_empty_subtree_archive_error,
    type Branch_Export_Options,
} from './archive.js';
