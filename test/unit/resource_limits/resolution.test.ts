/**
 * Three-layer precedence ladder (defaults → manifest → CLI) per-field merge.
 *
 * The resolver reads runtime defaults at resolve time (via `os.totalmem()`
 * and `os.cpus()`); we mock the whole `node:os` module so the default values
 * are deterministic across hardware. `vi.spyOn` doesn't work on ESM exports,
 * so the test installs a module factory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reset_host_state, type Host_State } from '../../helpers/node_os_mock.js';

const host_state = vi.hoisted((): Host_State => ({
    total_memory_bytes: 16 * 1024 * 1024 * 1024,
    cpu_count: 4,
}));

vi.mock('node:os', async (importOriginal) => {
    const { build_node_os_mock } = await import('../../helpers/node_os_mock.js');
    return build_node_os_mock(host_state, importOriginal);
});

import {
    resolve_resource_limits,
    UNLIMITED,
    type Persisted_Resource_Limits,
} from '../../../src/resource_limits.js';
import { EMPTY_LOADED_CONFIGURATION } from '../../../src/sandbox/persisted_resource_limits.js';

const NO_LOADED_CONFIGURATION = EMPTY_LOADED_CONFIGURATION;

describe('resolve_resource_limits — three-layer precedence', () => {
    beforeEach(() => {
        // 16 GiB host, 4 cores → defaults memory_limit=12g, cpu_limit=3.0, pids_limit=1024.
        reset_host_state(host_state);
    });

    it('first create with no manifest and no CLI falls through to defaults', () => {
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.memory_limit).toBe('12g');
        expect(resolved.cpu_limit).toBe('3.0');
        expect(resolved.pids_limit).toBe(1024);
        expect(resolved.blkio_weight).toBeNull();
    });

    it('CLI flag overrides default per-field', () => {
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, { memory_limit: '8g' });
        expect(resolved.memory_limit).toBe('8g');
        // Other fields fall through to defaults unchanged
        expect(resolved.cpu_limit).toBe('3.0');
        expect(resolved.pids_limit).toBe(1024);
    });

    it('manifest layer overrides default per-field', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g',
            cpu_limit: '2.0',
            pids_limit: 512,
            blkio_weight: 300,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, {});
        expect(resolved.memory_limit).toBe('14g');
        expect(resolved.cpu_limit).toBe('2.0');
        expect(resolved.pids_limit).toBe(512);
        expect(resolved.blkio_weight).toBe(300);
    });

    it('CLI overrides manifest per-field', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g',
            cpu_limit: '2.0',
            pids_limit: 512,
            blkio_weight: 300,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, { memory_limit: '4g' });
        expect(resolved.memory_limit).toBe('4g');
        // Other fields fall through to manifest (since no CLI for them)
        expect(resolved.cpu_limit).toBe('2.0');
        expect(resolved.pids_limit).toBe(512);
        expect(resolved.blkio_weight).toBe(300);
    });

    it('per-field merge: CLI flag for one field leaves manifest values intact for others', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g',
            cpu_limit: '2.0',
            pids_limit: 512,
            blkio_weight: 300,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, { cpu_limit: '1.0' });
        expect(resolved.cpu_limit).toBe('1.0');
        expect(resolved.memory_limit).toBe('14g');
        expect(resolved.pids_limit).toBe(512);
        expect(resolved.blkio_weight).toBe(300);
    });

    it('unlimited propagates through manifest layer', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: UNLIMITED,
            cpu_limit: '3.0',
            pids_limit: 1024,
            blkio_weight: null,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, {});
        expect(resolved.memory_limit).toBe(UNLIMITED);
    });

    it('CLI unlimited overrides concrete manifest value', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g',
            cpu_limit: '2.0',
            pids_limit: 512,
            blkio_weight: null,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, { memory_limit: UNLIMITED });
        expect(resolved.memory_limit).toBe(UNLIMITED);
    });

    it('CLI concrete value overrides manifest unlimited', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: UNLIMITED,
            cpu_limit: '2.0',
            pids_limit: 512,
            blkio_weight: null,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, { memory_limit: '4g' });
        expect(resolved.memory_limit).toBe('4g');
    });

    it('blkio_weight: no value at any precedence resolves to null (no flag emitted)', () => {
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, {});
        expect(resolved.blkio_weight).toBeNull();
    });

    it('blkio_weight: manifest value with no CLI flag carries through', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '12g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: 500,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, {});
        expect(resolved.blkio_weight).toBe(500);
    });

    it('blkio_weight: CLI flag overrides manifest', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '12g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: 500,
        };
        const resolved = resolve_resource_limits(NO_LOADED_CONFIGURATION, manifest, { blkio_weight: 200 });
        expect(resolved.blkio_weight).toBe(200);
    });
});
