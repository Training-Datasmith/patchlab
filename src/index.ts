// Sandbox lifecycle
export {
    create_sandbox,
    resume_sandbox,
    list_sandboxes,
    inspect_sandbox,
    destroy_sandbox,
    garbage_collect_sandboxes,
    get_working_directory,
} from './sandbox/index.js';
export type {
    Create_Sandbox_Options,
    Resume_Sandbox_Options,
    Sandbox_Info,
    Sandbox_Details,
    Repository_Branch_State,
    Session_Summary,
    Destroy_Sandbox_Options,
    Destroy_Sandbox_Result,
    Garbage_Collection_Options,
    Garbage_Collection_Result,
    Orphan_Branch_Outcome,
} from './sandbox/index.js';

// Change detection
export { diff_sandbox } from './changes.js';
export type { File_Change, File_Change_Type } from './changes.js';

// Patch generation
export { generate_patch, write_patch } from './patches.js';

// Patch application
export { apply_patch, apply_patch_file } from './apply.js';
export type { Apply_Result, Patch_File_Result, Apply_Options } from './apply.js';

// Branch application
export { apply_patchlab_branch, resolve_apply_repository } from './branch/index.js';
export type {
    Apply_Options as Branch_Apply_Options,
    Apply_Result as Branch_Apply_Result,
    Apply_Mode,
    Applied_Item,
    Skipped_Item,
    Apply_Conflict,
} from './branch/index.js';

// Image management
export { build_image, list_images, has_any_compatible_image, get_default_image, validate_image, validate_or_remove_image } from './images.js';
export type { Patchlab_Image, Build_Image_Options, Image_Validation } from './images.js';

// Project-language / base-image detection
export { detect_project } from './languages/index.js';
export type { Detected_Project } from './languages/index.js';

// Dependency detection
export { detect_requirements } from './detect/index.js';
export type {
    Sandbox_Requirement,
    System_Package_Requirement,
    Volume_Mount_Requirement,
    Environment_Variable_Requirement,
    Service_Requirement,
    Npm_Package_Requirement,
    Detected_Requirements,
    Requirement_Source,
} from './detect/index.js';

// Package resolution
export {
    detect_package_manager,
    resolve_capability,
    reverse_map_package,
    generate_install_command,
} from './capabilities.js';
export type { Package_Manager, Capability_Map } from './capabilities.js';

// Overrides
export { load_overrides, save_overrides, update_overrides } from './overrides.js';
export type { Patchlab_Overrides } from './overrides.js';
export { merge_requirements } from './overrides_merge.js';

// Services
export { SERVICE_MAP, match_containers_for_service, resolve_services, merge_service_selections } from './services.js';
export type { Service_Mapping } from './services.js';

// Prompts
export { resolve_socket_mount, prompt_service_selection } from './prompts.js';
export type { Prompter, Socket_Mount_Resolution, Service_Selection } from './prompts.js';

// Podman (container-runtime wrappers)
export { query_running_containers } from './podman.js';
export type { Running_Container } from './podman.js';

// Stale image detection
export { get_image_capabilities, check_stale_image } from './stale.js';
export type { Stale_Check_Result } from './stale.js';

// Manifest types
export type { Sandbox_Manifest } from './manifest.js';

// Tool providers
export { register_provider, get_provider, list_providers } from './tools/index.js';
export type { Authentication_Method, Authentication_Result, Tool_Provider } from './tools/index.js';
