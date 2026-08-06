/**
 * Truthy/falsy decoding for `PATCHLAB_VERBOSE`. Uses `is_verbose_mode_active`
 * directly so the test doesn't depend on `ConsoleLogger.verbose`'s side
 * effect (stderr emission). The CLI override is left `false` throughout —
 * see `verbose-cli-override.test.ts` for CLI-vs-env interaction.
 *
 * The recognized "off" set is closed: unset, empty, `'0'`, case-insensitive
 * `'false'`, case-insensitive `'off'`. Everything else (including `'no'`)
 * activates verbose mode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { is_verbose_mode_active, set_cli_verbose_override } from '../../../src/logger.js';

const VARIABLE_NAME = 'PATCHLAB_VERBOSE';

describe('is_verbose_mode_active — PATCHLAB_VERBOSE decoding', () => {
    let saved_value: string | undefined;

    beforeEach(() => {
        saved_value = process.env[VARIABLE_NAME];
        delete process.env[VARIABLE_NAME];
        set_cli_verbose_override(false);
    });

    afterEach(() => {
        if (saved_value === undefined) {
            delete process.env[VARIABLE_NAME];
        } else {
            process.env[VARIABLE_NAME] = saved_value;
        }

        set_cli_verbose_override(false);
    });

    describe('off-set: returns false', () => {
        it('returns false when the var is unset', () => {
            delete process.env[VARIABLE_NAME];
            expect(is_verbose_mode_active()).toBe(false);
        });

        it('returns false for empty string', () => {
            process.env[VARIABLE_NAME] = '';
            expect(is_verbose_mode_active()).toBe(false);
        });

        it('returns false for "0"', () => {
            process.env[VARIABLE_NAME] = '0';
            expect(is_verbose_mode_active()).toBe(false);
        });

        it.each(['false', 'False', 'FALSE', 'fAlSe'])('returns false for "%s"', (value) => {
            process.env[VARIABLE_NAME] = value;
            expect(is_verbose_mode_active()).toBe(false);
        });

        it.each(['off', 'Off', 'OFF', 'oFf'])('returns false for "%s"', (value) => {
            process.env[VARIABLE_NAME] = value;
            expect(is_verbose_mode_active()).toBe(false);
        });
    });

    describe('on-set: returns true', () => {
        it.each(['1', 'true', 'yes', 'on', 'please', '1.0'])('returns true for "%s"', (value) => {
            process.env[VARIABLE_NAME] = value;
            expect(is_verbose_mode_active()).toBe(true);
        });

        it('returns true for "no" — NOT in the documented off-set', () => {
            // Locks the doc/spec choice: only "0", "false", "off" are off.
            // Users wanting verbose off SHALL use one of those three values.
            process.env[VARIABLE_NAME] = 'no';
            expect(is_verbose_mode_active()).toBe(true);
        });
    });

    describe('no caching: each call re-reads the env var', () => {
        it('returns updated value when the env var changes between calls', () => {
            process.env[VARIABLE_NAME] = '1';
            expect(is_verbose_mode_active()).toBe(true);

            process.env[VARIABLE_NAME] = '0';
            expect(is_verbose_mode_active()).toBe(false);

            process.env[VARIABLE_NAME] = 'on';
            expect(is_verbose_mode_active()).toBe(true);
        });
    });
});