/**
 * Resource-limit flag emission in `create_container`. Mirrors the structure
 * of `podman-utilities.test.ts` (mocking `execFileSync` on `node:child_process`
 * and inspecting the argv passed to `podman create`). Each flag MUST appear
 * before the image positional argument when its option is set, and MUST be
 * omitted entirely when the option is `undefined`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { create_container } from '../../../src/container_runtime.js';

const mocked_exec = vi.mocked(execFileSync);

function captured_argv(): string[] {
    return mocked_exec.mock.calls[0][1] as string[];
}

function index_of_image(argv: string[], image: string): number {
    return argv.indexOf(image);
}

describe('create_container — resource-limit flags', () => {
    beforeEach(() => {
        mocked_exec.mockReset();
    });

    it('emits --memory when memory_limit is set', () => {
        create_container('test', 'image:latest', { memory_limit: '4g' });
        const argv = captured_argv();
        expect(argv).toContain('--memory');
        expect(argv[argv.indexOf('--memory') + 1]).toBe('4g');
    });

    it('emits --cpus when cpu_limit is set', () => {
        create_container('test', 'image:latest', { cpu_limit: '2.0' });
        const argv = captured_argv();
        expect(argv).toContain('--cpus');
        expect(argv[argv.indexOf('--cpus') + 1]).toBe('2.0');
    });

    it('emits --pids-limit when pids_limit is set', () => {
        create_container('test', 'image:latest', { pids_limit: 1024 });
        const argv = captured_argv();
        expect(argv).toContain('--pids-limit');
        expect(argv[argv.indexOf('--pids-limit') + 1]).toBe('1024');
    });

    it('emits --blkio-weight when blkio_weight is set', () => {
        create_container('test', 'image:latest', { blkio_weight: 500 });
        const argv = captured_argv();
        expect(argv).toContain('--blkio-weight');
        expect(argv[argv.indexOf('--blkio-weight') + 1]).toBe('500');
    });

    it('emits all four flags when all are set', () => {
        create_container('test', 'image:latest', {
            memory_limit: '4g',
            cpu_limit: '2.0',
            pids_limit: 1024,
            blkio_weight: 500,
        });
        const argv = captured_argv();
        expect(argv).toContain('--memory');
        expect(argv).toContain('--cpus');
        expect(argv).toContain('--pids-limit');
        expect(argv).toContain('--blkio-weight');
    });

    it('omits a flag entirely when its option is undefined', () => {
        // memory_limit: undefined → --memory must not appear at all
        create_container('test', 'image:latest', {
            cpu_limit: '2.0',
            // memory_limit, pids_limit, blkio_weight intentionally omitted
        });
        const argv = captured_argv();
        expect(argv).not.toContain('--memory');
        expect(argv).not.toContain('--pids-limit');
        expect(argv).not.toContain('--blkio-weight');
        // cpus still appears
        expect(argv).toContain('--cpus');
    });

    it('omits all four flags when none are set', () => {
        create_container('test', 'image:latest', {});
        const argv = captured_argv();
        expect(argv).not.toContain('--memory');
        expect(argv).not.toContain('--cpus');
        expect(argv).not.toContain('--pids-limit');
        expect(argv).not.toContain('--blkio-weight');
    });

    it('places resource-limit flags BEFORE the image positional argument', () => {
        const image = 'image:latest';
        create_container('test', image, {
            memory_limit: '4g',
            cpu_limit: '2.0',
            pids_limit: 1024,
            blkio_weight: 500,
        });
        const argv = captured_argv();
        const image_index = index_of_image(argv, image);
        expect(image_index).toBeGreaterThan(0);
        expect(argv.indexOf('--memory')).toBeLessThan(image_index);
        expect(argv.indexOf('--cpus')).toBeLessThan(image_index);
        expect(argv.indexOf('--pids-limit')).toBeLessThan(image_index);
        expect(argv.indexOf('--blkio-weight')).toBeLessThan(image_index);
    });
});
