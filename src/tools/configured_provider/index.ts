/**
 * Public re-export barrel for the configured tool-provider subsystem.
 *
 * The granular sibling files (`types.ts`, `validators.ts`, `path_resolution.ts`,
 * `authentication.ts`, `dockerfile.ts`, `artifacts.ts`, `parse.ts`,
 * `discovery.ts`, `trust_hash.ts`, `image_build.ts`, `provider_class.ts`)
 * are the implementation; importers consume the surface through this barrel
 * so the per-concern boundaries can move without rippling through callers.
 */

export type {
    Base_Family,
    Configured_Tool_Provider_Manifest,
    Manifest_Authentication,
    Manifest_File_Copy,
    Manifest_Parse_Error,
} from './types.js';

export {
    assert_host_path_within_source,
    expand_container_path,
    expand_host_path,
    type Host_Path_Containment_Options,
} from './path_resolution.js';

export {
    parse_manifest,
    type Parse_Manifest_Options,
} from './parse.js';

export {
    discover_per_source_manifest_paths,
    discover_user_global_manifest_paths,
    parse_manifest_from_buffer,
    read_and_parse_manifest,
    read_per_source_manifest_buffers,
} from './discovery.js';

export {
    assert_no_within_scope_name_conflicts,
    compute_manifest_hash,
    compute_trusted_manifests_hash,
    format_warning,
} from './trust_hash.js';

export { Configured_Tool_Provider } from './provider_class.js';
