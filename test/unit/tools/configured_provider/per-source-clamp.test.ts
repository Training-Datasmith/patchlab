/**
 * Per-source clamp behavior — the specific subset of the five-layer
 * precedence that records `logger().verbose(...)` events. Uses a
 * `RecordingLogger` installed via `set_logger` so the assertions can confirm
 * each clamp/discard/ignore event fired exactly once with a message naming
 * the documented fields. The activation-gate (env var, CLI flag, stderr
 * formatting) is the `verbose-logging` change's concern and is tested
 * separately — `RecordingLogger.verbose` captures unconditionally, so this
 * test does NOT toggle PATCHLAB_VERBOSE or spy on process.stderr.
 *
 * `node:os` is mocked for deterministic runtime defaults.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reset_host_state, type Host_State } from '../../../helpers/node_os_mock.js';

const host_state = vi.hoisted((): Host_State => ({
    total_memory_bytes: 16 * 1024 * 1024 * 1024,
    cpu_count: 4,
}));

vi.mock('node:os', async (importOriginal) => {
    const { build_node_os_mock } = await import('../../../helpers/node_os_mock.js');
    return build_node_os_mock(host_state, importOriginal);
});

import {
    resolve_resource_limits,
    UNLIMITED,
    type Persisted_Resource_Limits,
} from '../../../../src/resource_limits.js';
import type { Loaded_Resource_Limits } from '../../../../src/configuration.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../../../helpers/recording_logger.js';

function empty_loaded(): Loaded_Resource_Limits {
    return { memory_limit: null, cpu_limit: null, pids_limit: null, blkio_weight: null };
}

const recording_handle = install_recording_logger_hooks();
let recording: RecordingLogger;

beforeEach(() => {
    reset_host_state(host_state);
    recording = recording_handle.current();
});

function verbose_messages(): string[] {
    return recording.calls
        .filter((c) => c.method === 'verbose' && typeof c.message === 'string')
        .map((c) => c.message as string);
}

describe('per-source raises clamped to user-global', () => {
    it('memory: per-source 8g vs user-global 4g → effective 4g + one clamp event', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '4g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '8g',
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('4g');

        const messages = verbose_messages();
        const memory_events = messages.filter((m) => m.includes('memory'));
        expect(memory_events.length).toBe(1);
        // Message names field, per-source value, upper bound, effective value.
        expect(memory_events[0]).toContain('memory');
        expect(memory_events[0]).toContain('8g');
        expect(memory_events[0]).toContain('4g');
    });
});

describe('per-source tightens within bound — no clamp event', () => {
    it('memory: per-source 2g vs user-global 8g → effective 2g + no clamp event', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '8g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '2g',
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('2g');
        expect(verbose_messages().filter((m) => m.includes('memory'))).toEqual([]);
    });
});

describe('per-source unlimited (0) discarded — does NOT widen', () => {
    it('per-source memory: 0 vs user-global 4g → effective 4g + one discarded-preference event', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '4g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: UNLIMITED,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('4g');

        const memory_events = verbose_messages().filter((m) => m.includes('memory'));
        expect(memory_events.length).toBe(1);
        expect(memory_events[0]).toContain('discarded');
    });
});

describe('per-source clamped against runtime default when no user-global', () => {
    it('per-source memory 16g vs default 12g → effective 12g + clamp event', () => {
        // 16 GiB host → default memory_limit = 12g. Per-source asks for 16g;
        // gets clamped to the runtime default since there's no user-global
        // setting in between.
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '16g',
        };
        const resolved = resolve_resource_limits(
            { user_global: null, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('12g');

        const events = verbose_messages().filter((m) => m.includes('memory'));
        expect(events.length).toBe(1);
        expect(events[0]).toContain('16g');
        expect(events[0]).toContain('12g');
    });
});

describe('per-source tightens an unlimited user-global to a concrete value', () => {
    it('per-source memory 2g vs user-global unlimited → effective 2g + no clamp event', () => {
        // Within an unbounded ceiling — exactly the intended use of per-source.
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: UNLIMITED,
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '2g',
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe('2g');
        expect(verbose_messages().filter((m) => m.includes('memory'))).toEqual([]);
    });
});

describe('per-source unlimited against unlimited user-global stays unlimited', () => {
    // Spec scenario: both layers want unlimited → the result is unlimited.
    // Verifies the corner of the truth table where `apply_per_source_clamp`
    // sees `per_source_value === UNLIMITED` AND `upper_bound === UNLIMITED`,
    // and the discarded-preference branch returns the upper bound (which is
    // itself UNLIMITED).
    it('user-global memory 0 (unlimited) + per-source memory 0 → effective unlimited + discarded event', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: UNLIMITED,
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: UNLIMITED,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.memory_limit).toBe(UNLIMITED);

        // The per-source `unlimited` is discarded (it cannot widen above the
        // already-unlimited user-global ceiling). One verbose event records
        // the discarded preference for `memory`. The wording is specialized
        // for the "bound is already unlimited" case so the message doesn't
        // read as the tautology "no widening above unlimited" — instead it
        // explicitly says lower layers already resolved to unlimited.
        const events = verbose_messages().filter((m) => m.includes('memory'));
        expect(events.length).toBe(1);
        expect(events[0]).toContain('discarded');
        expect(events[0]).toContain('unlimited');
        expect(events[0]).toContain('lower-precedence layers already resolve to unlimited');
        // Negative assertion: the tautological wording must NOT appear.
        expect(events[0]).not.toContain('no widening above unlimited');
    });
});

describe('per-source blkio_weight always ignored', () => {
    it('per-source blkio_weight: 800 → ignored + one ignored-field event', () => {
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            blkio_weight: 800,
        };
        const resolved = resolve_resource_limits(
            { user_global: null, per_source },
            null,
            {},
        );
        // blkio_weight has no runtime default and the per-source value is
        // discarded, so the effective value falls all the way through to null.
        expect(resolved.blkio_weight).toBeNull();

        const events = verbose_messages().filter((m) => m.includes('blkio_weight'));
        expect(events.length).toBe(1);
        expect(events[0]).toContain('ignored');
    });

    it('user-global blkio_weight + per-source blkio_weight → per-source ignored, user-global wins', () => {
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            blkio_weight: 300,
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            blkio_weight: 800,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );
        expect(resolved.blkio_weight).toBe(300);

        const events = verbose_messages().filter((m) => m.includes('blkio_weight'));
        expect(events.length).toBe(1);
        expect(events[0]).toContain('ignored');
    });
});

describe('clamp ignores manifest and CLI as upper-bound contributors', () => {
    it('per-source clamped against user-global 4g even though manifest 14g and CLI 14g exist', () => {
        // Per-source SHOULD see only layers 1+2 as upper bound. Manifest's
        // 14g and CLI's 14g sit above per-source in the ladder — they don't
        // raise the clamp ceiling.
        const user_global: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '4g',
        };
        const per_source: Loaded_Resource_Limits = {
            ...empty_loaded(),
            memory_limit: '8g',
        };
        const manifest: Persisted_Resource_Limits = {
            memory_limit: '14g', cpu_limit: '3.0', pids_limit: 1024, blkio_weight: null,
        };
        const resolved = resolve_resource_limits(
            { user_global, per_source },
            manifest,
            { memory_limit: '14g' },
        );
        // Clamp upper bound was 4g (user-global). Per-source 8g was clamped
        // to 4g. Then manifest overrides to 14g. Then CLI overrides to 14g.
        // So the FINAL value is 14g (CLI), but the CLAMP EVENT records the
        // 8g → 4g clamp (not 8g → 14g).
        expect(resolved.memory_limit).toBe('14g');

        const events = verbose_messages().filter((m) => m.includes('memory'));
        expect(events.length).toBe(1);
        expect(events[0]).toContain('8g');
        expect(events[0]).toContain('4g');   // clamped against user-global, not against 14g manifest/CLI
        expect(events[0]).not.toContain('14g');
    });
});

describe('multiple clamps in one invocation produce one event per affected field', () => {
    it('memory and cpus both clamped, blkio_weight ignored → three verbose events total', () => {
        const user_global: Loaded_Resource_Limits = {
            memory_limit: '4g', cpu_limit: '2.0', pids_limit: 1024, blkio_weight: null,
        };
        const per_source: Loaded_Resource_Limits = {
            memory_limit: '8g',    // clamp
            cpu_limit: '4.0',      // clamp
            pids_limit: null,      // unset; no event
            blkio_weight: 800,     // ignored
        };
        resolve_resource_limits(
            { user_global, per_source },
            null,
            {},
        );

        const events = verbose_messages();
        expect(events.length).toBe(3);
        // One event per field; pids was not set on per-source, so no event for it.
        expect(events.filter((m) => m.includes('memory')).length).toBe(1);
        expect(events.filter((m) => m.includes('cpus')).length).toBe(1);
        expect(events.filter((m) => m.includes('blkio_weight')).length).toBe(1);
        expect(events.filter((m) => m.includes('pids')).length).toBe(0);
    });
});
