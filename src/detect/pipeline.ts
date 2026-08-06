/**
 * Detection orchestrator. Runs every detector against a project directory in
 * priority order (first wins for environment-variable conflicts), catches
 * per-detector failures with a logged warning, and merges/dedups the
 * accumulated `Sandbox_Requirement[]` into the typed `Detected_Requirements`
 * shape consumed by downstream callers.
 *
 * This module's `merge_requirements` is the internal post-detection merge;
 * `src/overrides_merge.ts` defines a separate `merge_requirements` for
 * combining the detected output with `.patchlab.json` overrides.
 */
import { logger } from '../logger.js';
import {
    dedupe_by_key,
    merge_environment_variable,
} from './helpers.js';
import {
    detect_ci_configuration,
    detect_composer,
    detect_configuration_files,
    detect_dev_dependencies,
    detect_docker_compose,
    detect_openspec,
    detect_php_extensions,
    detect_php_lock_extensions,
    detect_php_test_config,
    detect_source_code,
    detect_test_scripts,
} from './detectors.js';
import type {
    Detected_Requirements,
    Detector,
    Detector_Context,
    Environment_Variable_Requirement,
    Sandbox_Requirement,
} from './types.js';

// Detectors in priority order (first wins for environment variable conflicts)
const DETECTORS: { name: string; fn: Detector }[] = [
    { name: 'CI configuration', fn: detect_ci_configuration },
    { name: 'docker-compose', fn: detect_docker_compose },
    { name: 'source code', fn: detect_source_code },
    { name: 'test scripts', fn: detect_test_scripts },
    { name: 'devDependencies', fn: detect_dev_dependencies },
    { name: 'composer', fn: detect_composer },
    { name: 'PHP extensions', fn: detect_php_extensions },
    { name: 'PHP lock extensions', fn: detect_php_lock_extensions },
    { name: 'PHP test configuration', fn: detect_php_test_config },
    { name: 'configuration files', fn: detect_configuration_files },
    { name: 'openspec', fn: detect_openspec },
];

/** Run all detectors and merge/deduplicate results. */
export function detect_requirements(project_directory: string, context?: Readonly<Detector_Context>): Detected_Requirements {
    const all_requirements: Sandbox_Requirement[] = [];

    for (const detector of DETECTORS) {
        try {
            all_requirements.push(...detector.fn(project_directory, context));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(`Warning: ${detector.name} detector failed — ${message}`);
        }
    }

    return merge_requirements(all_requirements);
}

function merge_requirements(requirements: Sandbox_Requirement[]): Detected_Requirements {
    const result: Detected_Requirements = {
        system_packages: [],
        volume_mounts: [],
        environment_variables: [],
        services: [],
        npm_packages: [],
    };

    const seen_capabilities = new Set<string>();
    const seen_mounts = new Set<string>();
    const seen_env_keys = new Map<string, Environment_Variable_Requirement>();
    const seen_services = new Set<string>();
    const seen_npm_packages = new Set<string>();

    for (const requirement of requirements) {
        switch (requirement.type) {
            case 'system_package':
                dedupe_by_key(requirement, requirement.capability, seen_capabilities, result.system_packages);
                break;
            case 'volume_mount':
                dedupe_by_key(requirement, `${requirement.host_path}:${requirement.container_path}`, seen_mounts, result.volume_mounts);
                break;
            case 'environment_var':
                merge_environment_variable(requirement, seen_env_keys, result.environment_variables);
                break;
            case 'service':
                dedupe_by_key(requirement, requirement.name, seen_services, result.services);
                break;
            case 'npm_package':
                dedupe_by_key(requirement, requirement.package, seen_npm_packages, result.npm_packages);
                break;
        }
    }

    return result;
}
