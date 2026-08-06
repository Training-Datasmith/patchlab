/**
 * `ConsoleLogger.verbose` formatting contract:
 *   - Off → no writes
 *   - On + single line → one prefixed write
 *   - On + multi-line → one prefixed write per line (per-line prefix invariant)
 *   - On + trailing newline(s) → trailing newlines stripped; no spurious empty line
 *   - On + empty (after stripping) → no writes
 *   - On + embedded blank line → blank line preserved as a prefixed empty line
 *
 * Uses `vi.spyOn(process.stderr, 'write')` so the test exercises the
 * production code path (the actual stderr write) without a separate sink.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, set_cli_verbose_override } from '../../../src/logger.js';

const VARIABLE_NAME = 'PATCHLAB_VERBOSE';

describe('ConsoleLogger.verbose formatting', () => {
    let stderr_spy: ReturnType<typeof vi.spyOn>;
    let saved_value: string | undefined;

    beforeEach(() => {
        saved_value = process.env[VARIABLE_NAME];
        delete process.env[VARIABLE_NAME];
        stderr_spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    });

    afterEach(() => {
        stderr_spy.mockRestore();
        set_cli_verbose_override(false);
        if (saved_value === undefined) {
            delete process.env[VARIABLE_NAME];
        } else {
            process.env[VARIABLE_NAME] = saved_value;
        }
    });

    it('writes nothing when verbose mode is inactive', () => {
        // Off: PATCHLAB_VERBOSE unset, CLI override false.
        new ConsoleLogger().verbose('test');
        expect(stderr_spy).not.toHaveBeenCalled();
    });

    describe('verbose mode active (via CLI override)', () => {
        beforeEach(() => {
            set_cli_verbose_override(true);
        });

        it('writes a single prefixed line for a single-line message', () => {
            new ConsoleLogger().verbose('test');
            expect(stderr_spy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
                'patchlab[verbose]: test\n',
            ]);
        });

        it('writes one prefixed line per fragment for a multi-line message', () => {
            new ConsoleLogger().verbose('line1\nline2');
            expect(stderr_spy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
                'patchlab[verbose]: line1\n',
                'patchlab[verbose]: line2\n',
            ]);
        });

        it('strips a single trailing newline (no spurious empty prefixed line)', () => {
            new ConsoleLogger().verbose('hello\n');
            expect(stderr_spy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
                'patchlab[verbose]: hello\n',
            ]);
        });

        it('strips multiple trailing newlines', () => {
            new ConsoleLogger().verbose('hello\n\n\n');
            expect(stderr_spy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
                'patchlab[verbose]: hello\n',
            ]);
        });

        it('is a no-op for the empty string', () => {
            new ConsoleLogger().verbose('');
            expect(stderr_spy).not.toHaveBeenCalled();
        });

        it('is a no-op for input that reduces to empty after stripping', () => {
            new ConsoleLogger().verbose('\n\n');
            expect(stderr_spy).not.toHaveBeenCalled();
        });

        it('preserves embedded blank lines as prefixed empty lines', () => {
            new ConsoleLogger().verbose('a\n\nb');
            expect(stderr_spy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
                'patchlab[verbose]: a\n',
                'patchlab[verbose]: \n',
                'patchlab[verbose]: b\n',
            ]);
        });
    });

    describe('verbose mode active (via PATCHLAB_VERBOSE env var)', () => {
        beforeEach(() => {
            process.env[VARIABLE_NAME] = '1';
        });

        it('writes a prefixed line when activated by the env var', () => {
            new ConsoleLogger().verbose('env-activated');
            expect(stderr_spy.mock.calls.map((c: unknown[]) => c[0])).toEqual([
                'patchlab[verbose]: env-activated\n',
            ]);
        });
    });
});
