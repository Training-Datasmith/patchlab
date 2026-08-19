import { get_container_runtime } from './registry.js';

/** Fail fast when a vitest project pins a runtime that auto-detect did not select. */
export function assert_required_container_runtime(): void {
    const required = process.env.PATCHLAB_REQUIRED_CONTAINER_RUNTIME?.toLowerCase();
    if (required === undefined) {
        return;
    }

    const { kind } = get_container_runtime();
    if (kind !== required) {
        throw new Error(
            `Required container runtime "${required}" but resolved "${kind}". `
            + 'Set PATCHLAB_CONTAINER_RUNTIME or install the expected runtime.',
        );
    }
}
