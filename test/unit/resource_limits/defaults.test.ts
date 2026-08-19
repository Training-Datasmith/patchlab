/**
 * Runtime-computed defaults exercised against varying host capacities. Uses
 * `vi.mock('node:os', ...)` to override `totalmem()` and `cpus()` so the
 * test is host-independent and reproducible. `vi.spyOn` doesn't work on ESM
 * exports.
 *
 * Memory algorithm: `max(1 GiB, floor_to_256_MiB(0.75 * total_bytes))`.
 * CPU algorithm: `max(1, cpu_count - 1)` as a decimal string.
 * Pids: fixed 1024.
 * blkio_weight: no runtime default — never appears in the resolved value
 *   without an explicit source (covered in resource-limit-resolution.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Host_State } from '../../helpers/node_os_mock.js';

// `vi.hoisted` so the `vi.mock` factory can reach `host_state` at factory-call
// time. Inlined literal (not the helper's DEFAULT_HOST_STATE) because vi.hoisted
// runs before imports resolve. Mutations in `set_host` change the values
// reported by `totalmem()` / `cpus()` for subsequent calls.
const host_state = vi.hoisted((): Host_State => ({
    total_memory_bytes: 16 * 1024 * 1024 * 1024,
    cpu_count: 4,
}));

vi.mock('node:os', async (importOriginal) => {
    const { build_node_os_mock } = await import('../../helpers/node_os_mock.js');
    return build_node_os_mock(host_state, importOriginal);
});

import { resolve_resource_limits } from '../../../src/resource_limits.js';
import { EMPTY_LOADED_CONFIGURATION } from '../../../src/sandbox/persisted_resource_limits.js';

const NO_LOADED_CONFIGURATION = EMPTY_LOADED_CONFIGURATION;

function set_host(memory_bytes: number, cpu_count: number): void {
    host_state.total_memory_bytes = memory_bytes;
    host_state.cpu_count = cpu_count;
}

describe('runtime defaults — memory', () => {
    it('16 GiB → 12g (75% rounded to 256 MiB)', () => {
        set_host(16 * 1024 * 1024 * 1024, 4);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.memory_limit).toBe('12g');
    });

    it('8 GiB → 6g', () => {
        set_host(8 * 1024 * 1024 * 1024, 4);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.memory_limit).toBe('6g');
    });

    it('1.0 GiB → 1g (floor applied; 75% would give 768 MiB which is below the floor)', () => {
        // This is the test that distinguishes floor behavior from rounding.
        // A 1.5 GiB host would produce 1g via either rule and not surface the floor.
        set_host(1024 * 1024 * 1024, 4);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.memory_limit).toBe('1g');
    });

    it('32 GiB → 24g', () => {
        set_host(32 * 1024 * 1024 * 1024, 4);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.memory_limit).toBe('24g');
    });
});

describe('runtime defaults — cpus', () => {
    it('4-core → 3.0', () => {
        set_host(16 * 1024 * 1024 * 1024, 4);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.cpu_limit).toBe('3.0');
    });

    it('2-core → 1.0 (max(1, count-1))', () => {
        set_host(16 * 1024 * 1024 * 1024, 2);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.cpu_limit).toBe('1.0');
    });

    it('1-core → 1.0 (floor)', () => {
        set_host(16 * 1024 * 1024 * 1024, 1);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.cpu_limit).toBe('1.0');
    });

    it('32-core → 31.0', () => {
        set_host(16 * 1024 * 1024 * 1024, 32);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.cpu_limit).toBe('31.0');
    });
});

describe('runtime defaults — pids and blkio_weight', () => {
    it('pids default is fixed 1024 regardless of host', () => {
        set_host(8 * 1024 * 1024 * 1024, 4);
        expect(resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {}).pids_limit).toBe(1024);

        set_host(64 * 1024 * 1024 * 1024, 32);
        expect(resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {}).pids_limit).toBe(1024);
    });

    it('blkio_weight has no runtime default (null when nothing sets it)', () => {
        set_host(16 * 1024 * 1024 * 1024, 4);
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.blkio_weight).toBeNull();
    });
});

describe('runtime defaults — computed at resolve time, not module load', () => {
    it('host changes between two resolver calls reflect in the second result', () => {
        set_host(16 * 1024 * 1024 * 1024, 4);
        const first = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(first.memory_limit).toBe('12g');

        set_host(8 * 1024 * 1024 * 1024, 2);
        const second = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(second.memory_limit).toBe('6g');
        expect(second.cpu_limit).toBe('1.0');
    });
});
