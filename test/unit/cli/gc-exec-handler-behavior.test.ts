/**
 * Behavioral regression tests for two `handle_*_command` behaviors that the
 * surface-area latch (handler-input-validation.test.ts) intentionally does NOT
 * cover, both fixed in the cluster-6 correctness pass:
 *
 *   - `handle_gc_command` must report the ACTUAL removal count from the live
 *     pass, not the preview count, and must warn when the two diverge (the user
 *     confirmed a different set than was removed). The previous code printed
 *     `preview.destroyed.length`, masking any divergence.
 *
 *   - `handle_exec_command` must relay a nonzero child exit code through
 *     `process.exitCode` instead of letting the `execFileSync` throw surface as
 *     a stack trace and flatten every failure to exit 1 — otherwise
 *     `patchlab exec` is not scriptable.
 *
 * Both downstream leaves (`garbage_collect_sandboxes`, `inspect_sandbox`,
 * `exec_interactive`) are mocked; this file exercises only the handler-level
 * orchestration that owns these two behaviors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    install_recording_logger_hooks,
    filter_recorded_messages,
} from '../../helpers/recording_logger.js';

vi.mock('../../../src/sandbox/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/sandbox/index.js')>();
    return {
        ...actual,
        garbage_collect_sandboxes: vi.fn(),
        inspect_sandbox: vi.fn(),
    };
});

vi.mock('../../../src/container_runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/container_runtime.js')>();
    return {
        ...actual,
        exec_interactive: vi.fn(),
    };
});

import { handle_gc_command, handle_exec_command } from '../../../src/cli.js';
import { garbage_collect_sandboxes, inspect_sandbox } from '../../../src/sandbox/index.js';
import { exec_interactive } from '../../../src/container_runtime.js';

const mocked_garbage_collect = vi.mocked(garbage_collect_sandboxes);
const mocked_inspect_sandbox = vi.mocked(inspect_sandbox);
const mocked_exec_interactive = vi.mocked(exec_interactive);

const VALID_PATCHLAB_ID = '12345678-1234-1234-1234-123456789abc';

type Garbage_Collection_Result = Awaited<ReturnType<typeof garbage_collect_sandboxes>>;

/**
 * A minimal `Garbage_Collection_Result` carrying `count` stale sandboxes. Only
 * the fields the handler reads (`id`, `container_status`, `created_at`, and the
 * `destroyed`/`orphan_outcomes` lengths) are populated; the rest is cast away.
 */
function result_with(count: number): Garbage_Collection_Result {
    const destroyed = Array.from({ length: count }, (_unused, index) => ({
        id: `sandbox-${index}`,
        container_status: 'stale',
        created_at: '2026-01-01T00:00:00Z',
    }));
    return { destroyed, skipped: [], orphan_outcomes: [] } as unknown as Garbage_Collection_Result;
}

describe('handle_gc_command — removal-count reporting', () => {
    const logger_handle = install_recording_logger_hooks();

    beforeEach(() => {
        mocked_garbage_collect.mockReset();
    });

    it('reports the live removal count and warns when it diverges from the preview', async () => {
        // Preview lists two stale sandboxes; the live pass removes only one (e.g.
        // one was destroyed out-of-band, or a destroy failed). The user must be
        // told the real outcome, not the preview's stale count of 2.
        mocked_garbage_collect
            .mockResolvedValueOnce(result_with(2))
            .mockResolvedValueOnce(result_with(1));

        await handle_gc_command({ force: true });

        const info_messages = filter_recorded_messages(logger_handle.current(), 'info');
        const warn_messages = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(info_messages).toContain('1 sandbox(es) removed.');
        expect(info_messages).not.toContain('2 sandbox(es) removed.');
        expect(warn_messages.some((message) => /Removed 1 sandbox\(es\), but the preview listed 2/.test(message))).toBe(true);
        expect(mocked_garbage_collect).toHaveBeenCalledTimes(2);
    });

    it('does not warn when the live count matches the preview', async () => {
        mocked_garbage_collect
            .mockResolvedValueOnce(result_with(1))
            .mockResolvedValueOnce(result_with(1));

        await handle_gc_command({ force: true });

        const info_messages = filter_recorded_messages(logger_handle.current(), 'info');
        const warn_messages = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(info_messages).toContain('1 sandbox(es) removed.');
        expect(warn_messages).toHaveLength(0);
    });
});

describe('handle_exec_command — child exit-code propagation', () => {
    install_recording_logger_hooks();
    let original_exit_code: typeof process.exitCode;

    beforeEach(() => {
        original_exit_code = process.exitCode;
        process.exitCode = undefined;
        mocked_inspect_sandbox.mockReset();
        mocked_exec_interactive.mockReset();
        mocked_inspect_sandbox.mockReturnValue({
            container_name: 'patchlab-test-container',
            container_working_dir: '/workspace',
        } as unknown as ReturnType<typeof inspect_sandbox>);
    });

    afterEach(() => {
        process.exitCode = original_exit_code;
    });

    it('relays a nonzero child exit code via process.exitCode instead of throwing', () => {
        const child_failure = Object.assign(new Error('Command failed'), { status: 2 });
        mocked_exec_interactive.mockImplementation(() => {
            throw child_failure;
        });

        expect(() => handle_exec_command(VALID_PATCHLAB_ID, ['false'])).not.toThrow();
        expect(process.exitCode).toBe(2);
    });

    it('falls back to exit 1 when the failure carries no numeric status', () => {
        mocked_exec_interactive.mockImplementation(() => {
            throw new Error('spawn failure with no status');
        });

        expect(() => handle_exec_command(VALID_PATCHLAB_ID, ['whatever'])).not.toThrow();
        expect(process.exitCode).toBe(1);
    });
});
