/**
 * Public surface of the sandbox subsystem. Every importer outside
 * `src/sandbox/` sources symbols from here (`./sandbox/index.js`); the
 * sibling modules in this directory are internal implementation.
 *
 * One re-export block per sibling file (provisioning, inspect,
 * garbage_collection), plus a tail block for the three narrower entry points
 * (`check_required_for_resume`, `DEFAULT_SECRET_EXCLUDES`, the phase-handshake
 * functions) that tests import directly without going through the create or
 * resume flow.
 */

export {
    create_sandbox,
    resume_sandbox,
    type Create_Sandbox_Options,
    type Resume_Sandbox_Options,
} from './provisioning.js';

export {
    get_working_directory,
    list_sandboxes,
    inspect_sandbox,
    type Sandbox_Info,
    type Sandbox_Details,
    type Repository_Branch_State,
} from './inspect.js';

export {
    destroy_sandbox,
    garbage_collect_sandboxes,
    type Destroy_Sandbox_Options,
    type Destroy_Sandbox_Result,
    type Garbage_Collection_Options,
    type Garbage_Collection_Result,
    type Orphan_Branch_Outcome,
} from './garbage_collection.js';

export {
    check_required_for_resume,
    claim_session_directory,
    claim_session_number_from,
    type Session_Summary,
} from './session_archive.js';
export { DEFAULT_SECRET_EXCLUDES } from './workspace_staging.js';
export {
    execute_phase_1_preflight,
    execute_phase_2_mutations,
    rollback_phase_2_created_branches,
} from './branch_handshake.js';
