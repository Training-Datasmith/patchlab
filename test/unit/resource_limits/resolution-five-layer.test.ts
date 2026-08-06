/**
 * Five-layer precedence (defaults → user-global → per-source-clamped →
 * manifest → CLI) tests. The prior change's resolution test covers the
 * three lower-and-upper layers; this one focuses on:
 *   1. The two new layers slotting in at the right precedence.
 *   2. Per-field merging across all five layers — one field per layer can be
 *      set without disturbing the others.
 *   3. The persisted manifest NOT being clamped against the current
 *      user-global (the persisted layer carries the user's create-time
 *      choice forward intact).
 *
 * `node:os` is mocked so default values are deterministic.
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
import type { Loaded_Configuration, Loaded_Resource_Limits } from '../../../src/configuration.js';

function empty_loaded_resource_limits(): Loaded_Resource_Limits {
    return { memory_limit: null, cpu_limit: null, pids_limit: null, blkio_weight: null };
}

const NO_LOADED: Loaded_Configuration = { user_global: null, per_source: null };

describe('five-layer precedence — single field set at each layer', () => {
    beforeEach(() => {
        reset_host_state(host_state);   // 16 GiB / 4 cores → memory default 12g, cpus default 3.0
    });

    it('layer 1 only (default) — no other layers contribute', () => {
        const resolved = resolve_resource_limits(NO_LOADED, null, {});
        expect(resolved.memory_limit).toBe('12g');
        expect(resolved.cpu_limit).toBe('3.0');
        expect(resolved.pids_limit).toBe(1024);
    });

    it('layer 2 only (user-global) overrides default', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '8g',
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source: null },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('8g');
        expect(resolved.cpu_limit).toBe('3.0');  // fall through to default
    });

    it('layer 3 only (per-source) — no user-global; per-source-tightens runtime default', () => {
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '4g',  // below the 12g default
        };
        const resolved = resolve_resource_limits(
            { user_global: null, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('4g');
    });

    it('layer 4 only (manifest) overrides defaults', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g', cpu_limit: '2.0', pids_limit: 512, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(NO_LOADED, manifest, {});
        expect(resolved.memory_limit).toBe('14g');
        expect(resolved.cpu_limit).toBe('2.0');
        expect(resolved.pids_limit).toBe(512);
    });

    it('layer 5 only (CLI) overrides defaults', () => {
        const resolved = resolve_resource_limits(NO_LOADED, null, { memory_limit: '4g' });
        expect(resolved.memory_limit).toBe('4g');
        expect(resolved.cpu_limit).toBe('3.0');  // fall through to default
    });
});

describe('five-layer precedence — higher layers override lower per field', () => {
    beforeEach(() => {
        reset_host_state(host_state);
    });

    it('user-global overrides default', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '8g',
        };
        const resolved = resolve_resource_limits({ user_global, per_source: null }, null, {});
        expect(resolved.memory_limit).toBe('8g');
    });

    it('per-source-clamped overrides user-global within the clamp', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '8g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '4g',  // tightens within bound
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('4g');
    });

    it('persisted manifest overrides user-global AND per-source-clamped', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '4g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '2g',
        };
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            manifest,
            {},
        );
        // Persisted-manifest beats user-global and per-source-clamped.
        expect(resolved.memory_limit).toBe('14g');
    });

    it('persisted manifest is NOT clamped against current user-global', () => {
        // The scenario: a prior session was created (no user-global at that
        // time) with memory: 14g, and now the user-global says memory: 4g.
        // The persisted 14g must carry through — clamping it to 4g would
        // silently undo the user's create-time choice.
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '4g',
        };
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source: null },
            manifest,
            {},
        );
        expect(resolved.memory_limit).toBe('14g');
    });

    it('CLI flag overrides persisted manifest, user-global, and per-source', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '4g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '2g',
        };
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            manifest,
            { memory_limit: '6g' },
        );
        expect(resolved.memory_limit).toBe('6g');
    });

    it('CLI flag bypasses per-source clamp', () => {
        // The CLI is the user's per-invocation override; it's NOT clamped
        // against user-global or per-source. A user typing
        // `patchlab create --memory 16g` against a user-global of 4g gets 16g
        // because they explicitly asked for it on the command line.
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '4g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '2g',
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            { memory_limit: '16g' },
        );
        expect(resolved.memory_limit).toBe('16g');
    });
});

describe('per-field merge — multi-field five-layer interaction', () => {
    beforeEach(() => {
        reset_host_state(host_state);
    });

    it('different fields pick different layers in one invocation', () => {
        // memory wins from user-global; cpus wins from per-source (clamped);
        // pids wins from manifest; blkio_weight wins from CLI.
        const user_global: Loaded_Resource_Limits = {
            memory_limit: '8g', cpu_limit: '2.0', pids_limit: 512, blkio_weight: null,
        };
        const per_source: Loaded_Resource_Limits = {
            memory_limit: null, cpu_limit: '1.0', pids_limit: null, blkio_weight: null,
        };
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '8g',   // matches user-global; manifest layer no-op here
            cpu_limit: '1.0',     // matches per-source; manifest no-op here
            pids_limit: 256,      // overrides user-global 512
            blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            manifest,
            { blkio_weight: 800 },  // CLI sets only this field
        );
        expect(resolved.memory_limit).toBe('8g');
        expect(resolved.cpu_limit).toBe('1.0');
        expect(resolved.pids_limit).toBe(256);
        expect(resolved.blkio_weight).toBe(800);
    });

    it('per-source clamp is applied per-field — one field clamps, another passes', () => {
        const user_global: Loaded_Resource_Limits = {
            memory_limit: '4g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: null,
        };
        const per_source: Loaded_Resource_Limits = {
            memory_limit: '8g',  // would-be raise; gets clamped to 4g
            cpu_limit: '2.0',    // tightens within bound; stays 2.0
            pids_limit: null,    // unset; falls through to user-global 1024
            blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('4g');  // clamped
        expect(resolved.cpu_limit).toBe('2.0');    // tightened
        expect(resolved.pids_limit).toBe(1024);    // from user-global
    });
});

describe('regression: per-field merge is not document-level replacement', () => {
    beforeEach(() => {
        reset_host_state(host_state);
    });

    it('user-global sets memory only; cpus/pids fall through to defaults', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '8g',
        };
        const resolved = resolve_resource_limits({ user_global, per_source: null }, null, {});
        expect(resolved.memory_limit).toBe('8g');
        expect(resolved.cpu_limit).toBe('3.0');   // default
        expect(resolved.pids_limit).toBe(1024);   // default
    });

    it('CLI sets memory only; cpus from user-global, pids from manifest', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            cpu_limit: '2.0',
        };
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '4g', cpu_limit: '3.0', pids_limit: 256, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source: null },
            manifest,
            { memory_limit: '6g' },
        );
        expect(resolved.memory_limit).toBe('6g');  // CLI
        expect(resolved.cpu_limit).toBe('3.0');    // manifest (above user-global 2.0)
        expect(resolved.pids_limit).toBe(256);     // manifest
    });
});

describe('unlimited propagation across the five layers', () => {
    beforeEach(() => {
        reset_host_state(host_state);
    });

    it('user-global memory: 0 → memory_limit = "unlimited"', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: UNLIMITED,
        };
        const resolved = resolve_resource_limits({ user_global, per_source: null }, null, {});
        expect(resolved.memory_limit).toBe(UNLIMITED);
    });

    it('per-source memory: <concrete> tightens unlimited user-global to <concrete>', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: UNLIMITED,
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded_resource_limits(),
            memory_limit: '2g',
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('2g');
    });

    it('CLI unlimited overrides concrete persisted-manifest value', () => {
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            NO_LOADED,
            manifest,
            { memory_limit: UNLIMITED },
        );
        expect(resolved.memory_limit).toBe(UNLIMITED);
    });
});
