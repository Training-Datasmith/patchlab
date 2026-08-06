import { register_language_detector } from './registry.js';
import { BUILTIN_LANGUAGE_DETECTORS } from './builtins.js';
import { register_user_global_language_detectors } from './discovery.js';

/**
 * Register the built-in language detectors, in PROJECT_MARKERS order, mirroring
 * how src/tools/index.ts registers the built-in providers. Exported so tests
 * can restore the built-ins after resetting the registry.
 */
export function register_builtin_language_detectors(): void {
    for (const detector of BUILTIN_LANGUAGE_DETECTORS) {
        register_language_detector(detector);
    }
}

// Module-load registration: built-ins first, then user-global manifests (so a
// manifest whose marker matches a built-in overrides it).
register_builtin_language_detectors();
register_user_global_language_detectors();

export { detect_project } from './detect.js';
export { apply_version_extraction } from './strategy.js';
export {
    register_language_detector,
    list_language_detectors,
    _reset_language_detectors,
} from './registry.js';
export {
    register_user_global_language_detectors,
    discover_user_global_language_manifest_paths,
} from './discovery.js';
export type { Language_Detector, Version_Extraction, Detected_Project } from './types.js';
