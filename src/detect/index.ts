/**
 * Public re-exports for the detection module. Callers should import from
 * `./detect/index.js` — the internal files (`types`, `helpers`, `detectors`,
 * `pipeline`) are implementation details.
 */
export { detect_requirements } from './pipeline.js';
export { resolve_podman_socket_path } from './helpers.js';
export type {
    Detected_Requirements,
    Detector_Context,
    Environment_Variable_Requirement,
    Npm_Package_Requirement,
    Requirement_Source,
    Sandbox_Requirement,
    Service_Requirement,
    System_Package_Requirement,
    Volume_Mount_Requirement,
} from './types.js';
