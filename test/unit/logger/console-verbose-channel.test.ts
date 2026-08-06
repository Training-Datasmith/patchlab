/**
 * Channel placement for `ConsoleLogger.verbose`: writes to stderr, never to
 * stdout. Mirrors the channel-routing tests for the other four methods in
 * `logger-console-channel.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, set_cli_verbose_override } from '../../../src/logger.js';

const VARIABLE_NAME = 'PATCHLAB_VERBOSE';

describe('ConsoleLogger.verbose channel routing', () => {
    let stdout_spy: ReturnType<typeof vi.spyOn>;
    let stderr_spy: ReturnType<typeof vi.spyOn>;
    let saved_value: string | undefined;

    beforeEach(() => {
        saved_value = process.env[VARIABLE_NAME];
        delete process.env[VARIABLE_NAME];
        stdout_spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        stderr_spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        set_cli_verbose_override(true);
    });

    afterEach(() => {
        stdout_spy.mockRestore();
        stderr_spy.mockRestore();
        set_cli_verbose_override(false);
        if (saved_value === undefined) {
            delete process.env[VARIABLE_NAME];
        } else {
            process.env[VARIABLE_NAME] = saved_value;
        }
    });

    it('writes to stderr, not stdout', () => {
        new ConsoleLogger().verbose('test');

        expect(stderr_spy).toHaveBeenCalledWith('patchlab[verbose]: test\n');
        expect(stdout_spy).not.toHaveBeenCalled();
    });

    it('multi-line messages still go entirely to stderr', () => {
        new ConsoleLogger().verbose('a\nb\nc');

        expect(stderr_spy.mock.calls.length).toBe(3);
        expect(stdout_spy).not.toHaveBeenCalled();
    });
});
