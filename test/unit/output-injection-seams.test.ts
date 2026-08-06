import { describe, it, expect, beforeEach } from 'vitest';
import { run_list_tools } from '../../src/list_tools.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../helpers/recording_logger.js';
import { register_default_test_tool } from '../helpers/stub_tool_provider.js';
import type { Manifest_Parse_Error } from '../../src/tools/configured_provider/index.js';

/**
 * Locks the "Existing output_log/output_warn seams continue to work" requirement
 * from the `logger` capability spec. Two pairs of scenarios:
 *   - Defaults route through the Logger (`output_log` → `logger().result`,
 *     `output_warn` → `logger().warn`).
 *   - Caller-supplied functions bypass the Logger entirely.
 *
 * Driver: `run_list_tools` from `src/list_tools.ts`, the smallest call site
 * that exercises both seams in one invocation. `user_global_errors` is passed
 * explicitly so the test does not depend on the module-load discovery cache.
 */

describe('output_log / output_warn injection seams (list_tools)', () => {
    const recording_handle = install_recording_logger_hooks();
    let recording_logger: RecordingLogger;

    beforeEach(() => {
        recording_logger = recording_handle.current();
        register_default_test_tool();
    });

    /** A single fake parse error so output_warn receives at least one line. */
    const one_parse_error: Manifest_Parse_Error = {
        manifest_path: '/manifests/broken.yaml',
        field_path: 'launch_command',
        reason: "missing required field 'launch_command'",
    };

    it('default output_log invokes logger().result for each listed provider row', () => {
        run_list_tools({ user_global_errors: [] });

        const result_calls = recording_logger.calls.filter((call) => call.method === 'result');
        expect(result_calls.length).toBeGreaterThan(0);
        // At least one of the lines should look like a provider-row format
        // ("<name>  (<display>)  [<source-label>]").
        expect(result_calls.some((call) => /\(.+\)\s+\[/.test(String(call.message)))).toBe(true);
    });

    it('default output_warn invokes logger().warn for each user-global parse error', () => {
        run_list_tools({ user_global_errors: [one_parse_error] });

        const warn_calls = recording_logger.calls.filter((call) => call.method === 'warn');
        expect(warn_calls.length).toBe(1);
        // The warning text contains the standardized format_warning shape
        // (rejected/broken.yaml plus the offending field path).
        expect(String(warn_calls[0].message)).toContain('rejected');
        expect(String(warn_calls[0].message)).toContain('launch_command');
    });

    it('caller-supplied output_log bypasses the Logger entirely', () => {
        const captured_lines: string[] = [];
        const my_capture = (line: string) => { captured_lines.push(line); };

        run_list_tools({
            output_log: my_capture,
            user_global_errors: [],
        });

        expect(captured_lines.length).toBeGreaterThan(0);
        // The Logger SHALL NOT receive any result calls when output_log is
        // caller-supplied — the bypass is the point of the seam.
        const result_calls = recording_logger.calls.filter((call) => call.method === 'result');
        expect(result_calls).toEqual([]);
    });

    it('caller-supplied output_warn bypasses the Logger entirely', () => {
        const captured_warnings: string[] = [];
        const my_capture = (line: string) => { captured_warnings.push(line); };

        run_list_tools({
            output_warn: my_capture,
            user_global_errors: [one_parse_error],
        });

        expect(captured_warnings.length).toBe(1);
        // The Logger SHALL NOT receive any warn calls when output_warn is
        // caller-supplied.
        const warn_calls = recording_logger.calls.filter((call) => call.method === 'warn');
        expect(warn_calls).toEqual([]);
    });
});
