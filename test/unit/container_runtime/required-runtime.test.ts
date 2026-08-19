import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { assert_required_container_runtime } from '../../../src/container_runtime/required_runtime.js';
import * as registry from '../../../src/container_runtime/registry.js';

describe('assert_required_container_runtime', () => {
    beforeEach(() => {
        registry._reset_container_runtime();
    });

    afterEach(() => {
        delete process.env.PATCHLAB_REQUIRED_CONTAINER_RUNTIME;
        delete process.env.PATCHLAB_CONTAINER_RUNTIME;
        registry._reset_container_runtime();
        vi.restoreAllMocks();
    });

    it('no-ops when PATCHLAB_REQUIRED_CONTAINER_RUNTIME is unset', () => {
        expect(() => assert_required_container_runtime()).not.toThrow();
    });

    it('throws when the resolved runtime does not match the requirement', () => {
        process.env.PATCHLAB_REQUIRED_CONTAINER_RUNTIME = 'nerdctl';
        vi.spyOn(registry, 'get_container_runtime').mockReturnValue({
            kind: 'podman',
            binary: 'podman',
        });

        expect(() => assert_required_container_runtime()).toThrow(/Required container runtime "nerdctl"/);
    });

    it('succeeds when the resolved runtime matches the requirement', () => {
        process.env.PATCHLAB_REQUIRED_CONTAINER_RUNTIME = 'nerdctl';
        vi.spyOn(registry, 'get_container_runtime').mockReturnValue({
            kind: 'nerdctl',
            binary: 'nerdctl.lima',
        });

        expect(() => assert_required_container_runtime()).not.toThrow();
    });
});
