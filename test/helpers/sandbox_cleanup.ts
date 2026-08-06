import { afterEach } from 'vitest';
import { destroy_sandbox } from '../../src/sandbox/index.js';
import type { Sandbox_Manifest } from '../../src/manifest.js';

/**
 * Per-test sandbox cleanup. Tests that call `create_sandbox` push the resulting
 * manifest (or just its `id`) into `ids`; the installed `afterEach` hook then
 * tears every sandbox down, swallowing per-ID errors so cleanup of later IDs
 * still runs after one of them fails.
 *
 * Consumers typically destructure this into `const { track, ids: sandbox_ids }
 * = install_sandbox_cleanup_hooks();` so the test bodies keep their existing
 * `track(manifest)` / `sandbox_ids.push(...)` shorthand.
 */
export interface Sandbox_Tracker_Hooks {
    /** Mutable list of sandbox IDs to destroy in `afterEach`. */
    readonly ids: string[];
    /** Record a manifest's ID for cleanup and return the manifest unchanged. */
    track: (manifest: Sandbox_Manifest) => Sandbox_Manifest;
}

export function install_sandbox_cleanup_hooks(): Sandbox_Tracker_Hooks {
    const ids: string[] = [];

    afterEach(async () => {
        for (const id of ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch {
                // Intentional: cleanup is best-effort. `destroy_sandbox` may
                // throw when the sandbox is already gone (failure-path tests
                // partially tear down state), when the mocked podman rejects
                // a call, or when the archive directory was never created.
            }
        }
        ids.length = 0;
    });

    return {
        ids,
        track(manifest) {
            ids.push(manifest.id);
            return manifest;
        },
    };
}
