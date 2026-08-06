/**
 * Merging detected sandbox requirements with `.patchlab.json` overrides.
 *
 * The detector produces a `Detected_Requirements` from project files; the
 * user's `Patchlab_Overrides` can ignore detected items, force-add explicit
 * ones, or replace specific environment-variable values. `merge_requirements`
 * applies that combination, with explicit additions winning over ignores
 * when both target the same item.
 *
 * `split_mount` is the local helper that turns the `"host:container"` mount
 * strings the override schema accepts into the two-field shape the
 * `Volume_Mount_Requirement` uses; it lives here because it is only ever
 * called from the merge pipeline.
 */
import type { Detected_Requirements } from './detect/index.js';
import type { Patchlab_Overrides } from './overrides.js';

/** Split a "host:container" mount string, handling Windows drive letters (e.g. C:\path). */
export function split_mount(mount: string): [string, string] {
    const start = /^[A-Za-z]:/.test(mount) ? 2 : 0;
    const separator_location = mount.indexOf(':', start);
    if (separator_location === -1) {
        throw new Error(`Invalid volume mount (missing ':'): ${mount}`);
    }

    return [mount.slice(0, separator_location), mount.slice(separator_location + 1)];
}

/**
 * Merge detected requirements with .patchlab.json overrides.
 * - `ignore_detected` removes matching requirements (exact match)
 * - Explicit additions in `requirements` win over `ignore_detected`
 * - Overrides environment variables replace detected environment variables with the same key
 */
export function merge_requirements(
    detected: Detected_Requirements,
    overrides: Patchlab_Overrides,
): Detected_Requirements {
    const ignore = new Set(overrides.ignore_detected ?? []);
    const explicit_packages = new Set(overrides.requirements?.system_packages ?? []);
    const explicit_mount_paths = new Set(overrides.requirements?.volume_mounts ?? []);
    const explicit_env = overrides.requirements?.environment_variables ?? {};
    const explicit_env_keys = new Set(Object.keys(explicit_env));

    // Filter detected, applying ignore (unless explicitly re-added)
    const system_packages = detected.system_packages.filter((r) => {
        if (explicit_packages.has(r.capability)) {
            // explicit wins
            return true;
        }
        return !ignore.has(r.capability);
    });

    const volume_mounts = detected.volume_mounts.filter((r) => {
        const mount_str = `${r.host_path}:${r.container_path}`;
        if (explicit_mount_paths.has(mount_str)) {
            return true;
        }
        return !ignore.has(mount_str);
    });

    const environment_vars = detected.environment_variables.filter((r) => {
        if (explicit_env_keys.has(r.key)) {
            // will be overridden below
            return true;
        }
        return !ignore.has(r.key);
    });

    const services = detected.services.filter((r) => !ignore.has(r.name));

    // Add explicit system packages not already detected
    const detected_capabilities = new Set(system_packages.map((r) => r.capability));
    for (const capability of explicit_packages) {
        if (!detected_capabilities.has(capability)) {
            system_packages.push({ type: 'system_package', capability, source: 'configuration_files' });
        }
    }

    // Add explicit volume mounts not already detected
    const detected_mounts = new Set(volume_mounts.map((r) => `${r.host_path}:${r.container_path}`));
    for (const mount of explicit_mount_paths) {
        if (!detected_mounts.has(mount)) {
            const [host_path, container_path] = split_mount(mount);
            volume_mounts.push({ type: 'volume_mount', host_path, container_path, source: 'configuration_files' });
        }
    }

    // Override/add explicit environment variables
    const env_map = new Map(environment_vars.map((r) => [r.key, r]));
    for (const [key, value] of Object.entries(explicit_env)) {
        env_map.set(key, { type: 'environment_var', key, value, source: 'configuration_files' });
    }

    // Npm packages: filter by ignore, then add explicit
    const explicit_npm = new Set(overrides.requirements?.npm_packages ?? []);
    const npm_packages = (detected.npm_packages ?? []).filter(
        (r) => explicit_npm.has(r.package) || !ignore.has(r.package),
    );
    const detected_npm = new Set(npm_packages.map((r) => r.package));
    for (const package_name of explicit_npm) {
        if (!detected_npm.has(package_name)) {
            npm_packages.push({ type: 'npm_package', package: package_name, source: 'configuration_files' });
        }
    }

    return {
        system_packages,
        volume_mounts,
        environment_variables: Array.from(env_map.values()),
        services,
        npm_packages,
    };
}
