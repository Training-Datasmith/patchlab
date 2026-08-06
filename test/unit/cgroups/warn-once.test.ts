/**
 * `warn_once_if_unsupported` emits exactly one warning per process when the
 * cgroup probe reports unsupported, and is silent on subsequent calls. The
 * test installs a `RecordingLogger` via `set_logger` (the pattern established
 * by `injectable-logger`) so the warning is captured through the Logger
 * surface rather than via a `process.stderr` spy — that channel bypass would
 * skip the abstraction the production code is required to use.
 *
 * `vi.spyOn` doesn't work on ESM namespace exports, so `node:fs` is mocked
 * through a factory backed by a mutable state object.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fs_state: {
    handler: ((file_path: string) => string) | null;
} = { handler: null };

vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return {
        ...original,
        readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
            if (fs_state.handler !== null) {
                return fs_state.handler(String(args[0]));
            }
            return original.readFileSync(...args);
        },
    };
});

import {
    warn_once_if_unsupported,
    _reset_cgroup_probe_state_for_tests,
} from '../../../src/cgroups.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../../helpers/recording_logger.js';

const ORIGINAL_PLATFORM = process.platform;

function set_platform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
}

function mock_unsupported_linux(): void {
    set_platform('linux');
    fs_state.handler = (file_path) => {
        if (file_path === '/proc/self/cgroup') {
            return '0::/test\n';
        }
        return 'cpuset io pids\n'; // no memory, no cpu
    };
}

describe('warn_once_if_unsupported', () => {
    const recording_handle = install_recording_logger_hooks();
    let recording: RecordingLogger;

    beforeEach(() => {
        _reset_cgroup_probe_state_for_tests();
        fs_state.handler = null;
        recording = recording_handle.current();
    });

    afterEach(() => {
        _reset_cgroup_probe_state_for_tests();
        fs_state.handler = null;
        set_platform(ORIGINAL_PLATFORM);
    });

    it('first call on unsupported host emits one warning through logger().warn', () => {
        mock_unsupported_linux();
        warn_once_if_unsupported();

        const warn_calls = recording.calls.filter((c) => c.method === 'warn');
        expect(warn_calls).toHaveLength(1);
    });

    it('second call in the same process is silent (warn-once latch)', () => {
        mock_unsupported_linux();
        warn_once_if_unsupported();
        warn_once_if_unsupported();
        warn_once_if_unsupported();

        const warn_calls = recording.calls.filter((c) => c.method === 'warn');
        expect(warn_calls).toHaveLength(1);
    });

    it('supported host emits no warning', () => {
        set_platform('linux');
        fs_state.handler = (file_path) => {
            if (file_path === '/proc/self/cgroup') {
                return '0::/test\n';
            }
            return 'cpu memory io pids\n';
        };
        warn_once_if_unsupported();

        const warn_calls = recording.calls.filter((c) => c.method === 'warn');
        expect(warn_calls).toHaveLength(0);
    });

    it('non-Linux platforms emit no warning (probe short-circuits to supported)', () => {
        set_platform('darwin');
        warn_once_if_unsupported();

        const warn_calls = recording.calls.filter((c) => c.method === 'warn');
        expect(warn_calls).toHaveLength(0);
    });

    it('warning text contains the four required elements (consequence, cause, documentation URL, reassurance)', () => {
        mock_unsupported_linux();
        warn_once_if_unsupported();

        const warn_calls = recording.calls.filter((c) => c.method === 'warn');
        expect(warn_calls).toHaveLength(1);
        const message = String(warn_calls[0].message);

        // (a) consequence — "cannot enforce" + "limits"
        expect(message).toMatch(/cannot enforce.*limits/i);
        // (b) cause — "rootless Podman"
        expect(message).toContain('rootless Podman');
        // (c) documentation URL — anchored at #cgroup-delegation
        expect(message).toContain('https://github.com/Training-Datasmith/patchlab/blob/main/documents/configuration.md#cgroup-delegation');
        // (d) reassurance — sandbox creation continues
        expect(message).toMatch(/will continue|continue/i);
    });
});
