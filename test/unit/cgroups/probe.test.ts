/**
 * Cgroup capability probe — exercises the filesystem-reading paths through
 * a `vi.mock('node:fs', ...)` factory that backs `readFileSync` with a
 * mutable state object. Each test resets the module-level probe cache so
 * cases are independent. (`vi.spyOn` doesn't work on ESM namespace exports.)
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
    probe_cgroup_capabilities,
    _reset_cgroup_probe_state_for_tests,
} from '../../../src/cgroups.js';

const ORIGINAL_PLATFORM = process.platform;

function set_platform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('probe_cgroup_capabilities', () => {
    beforeEach(() => {
        _reset_cgroup_probe_state_for_tests();
        fs_state.handler = null;
    });

    afterEach(() => {
        _reset_cgroup_probe_state_for_tests();
        fs_state.handler = null;
        set_platform(ORIGINAL_PLATFORM);
    });

    it('non-Linux short-circuits to supported without filesystem access', () => {
        set_platform('darwin');
        let read_count = 0;
        fs_state.handler = () => {
            read_count++;
            return '';
        };

        const probe = probe_cgroup_capabilities();
        expect(probe).toEqual({ supported: true, reason: 'non-linux' });
        expect(read_count).toBe(0);
    });

    it('Linux with both memory and cpu controllers returns supported', () => {
        set_platform('linux');
        fs_state.handler = (file_path) => {
            if (file_path === '/proc/self/cgroup') {
                return '0::/user.slice/user-1000.slice/session.scope\n';
            }
            if (file_path === '/sys/fs/cgroup/user.slice/user-1000.slice/session.scope/cgroup.controllers') {
                return 'cpuset cpu io memory pids\n';
            }
            throw new Error(`unexpected read: ${file_path}`);
        };

        const probe = probe_cgroup_capabilities();
        expect(probe.supported).toBe(true);
    });

    it('Linux missing memory controller returns unsupported naming the missing controller', () => {
        set_platform('linux');
        fs_state.handler = (file_path) => {
            if (file_path === '/proc/self/cgroup') {
                return '0::/test\n';
            }
            return 'cpuset cpu io pids\n'; // no memory
        };

        const probe = probe_cgroup_capabilities();
        expect(probe.supported).toBe(false);
        if (!probe.supported) {
            expect(probe.reason).toContain('memory');
        }
    });

    it('Linux without a 0:: unified-hierarchy line returns unsupported (pure cgroup v1)', () => {
        set_platform('linux');
        fs_state.handler = (file_path) => {
            if (file_path === '/proc/self/cgroup') {
                // Pure cgroup v1: only `N:controller:path` lines, no 0:: entry.
                return '12:cpuset:/\n11:cpu:/\n10:memory:/\n';
            }
            throw new Error(`unexpected read: ${file_path}`);
        };

        const probe = probe_cgroup_capabilities();
        expect(probe.supported).toBe(false);
        if (!probe.supported) {
            expect(probe.reason).toContain('cgroup v2');
        }
    });

    it('Linux with unreadable /proc/self/cgroup returns unsupported (does not throw)', () => {
        set_platform('linux');
        fs_state.handler = () => {
            throw new Error('ENOENT: no such file');
        };

        expect(() => probe_cgroup_capabilities()).not.toThrow();
        const probe = probe_cgroup_capabilities();
        expect(probe.supported).toBe(false);
        if (!probe.supported) {
            expect(probe.reason).toContain('/proc/self/cgroup');
        }
    });

    it('Linux with unreadable cgroup.controllers returns unsupported', () => {
        set_platform('linux');
        fs_state.handler = (file_path) => {
            if (file_path === '/proc/self/cgroup') {
                return '0::/test\n';
            }
            throw new Error('EACCES: permission denied');
        };

        const probe = probe_cgroup_capabilities();
        expect(probe.supported).toBe(false);
    });

    it('probe result is cached across calls (filesystem reads happen once)', () => {
        set_platform('linux');
        let read_count = 0;
        fs_state.handler = (file_path) => {
            read_count++;
            if (file_path === '/proc/self/cgroup') {
                return '0::/cached-test\n';
            }
            return 'cpu memory io pids\n';
        };

        probe_cgroup_capabilities();
        const reads_after_first = read_count;

        probe_cgroup_capabilities();
        probe_cgroup_capabilities();
        expect(read_count).toBe(reads_after_first);
    });
});
