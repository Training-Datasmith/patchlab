/**
 * CLI override vs environment variable interaction. Locks the "CLI wins"
 * precedence documented in the logger capability:
 *   - override true + environment off → true (CLI wins)
 *   - override false + environment on → true (environment carries when CLI absent)
 *   - override false + environment off → false
 *
 * Each test restores the override to `false` in cleanup so state does not
 * leak between cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { is_verbose_mode_active, set_cli_verbose_override } from '../../../src/logger.js';

const VARIABLE_NAME = 'PATCHLAB_VERBOSE';
const OFF_VALUES = [undefined, '', '0', 'false', 'FALSE', 'off', 'OFF'] as const;

describe('verbose CLI override precedence', () => {
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

    describe('CLI override wins over every off-set env value', () => {
        for (const off_value of OFF_VALUES) {
            it(`override=true + PATCHLAB_VERBOSE=${off_value === undefined ? '<unset>' : JSON.stringify(off_value)} → active`, () => {
                if (off_value === undefined) {
                    delete process.env[VARIABLE_NAME];
                } else {
                    process.env[VARIABLE_NAME] = off_value;
                }

                set_cli_verbose_override(true);
                expect(is_verbose_mode_active()).toBe(true);
            });
        }
    });

    it('override=false + env on → active (env carries when CLI absent)', () => {
        process.env[VARIABLE_NAME] = '1';
        set_cli_verbose_override(false);
        expect(is_verbose_mode_active()).toBe(true);
    });

    it('override=false + env off → inactive', () => {
        process.env[VARIABLE_NAME] = '0';
        set_cli_verbose_override(false);
        expect(is_verbose_mode_active()).toBe(false);
    });

    it('override=false + env unset → inactive', () => {
        delete process.env[VARIABLE_NAME];
        set_cli_verbose_override(false);
        expect(is_verbose_mode_active()).toBe(false);
    });

    it('setting then clearing the override returns to env-based behavior', () => {
        process.env[VARIABLE_NAME] = '0';
        set_cli_verbose_override(true);
        expect(is_verbose_mode_active()).toBe(true);

        set_cli_verbose_override(false);
        expect(is_verbose_mode_active()).toBe(false);
    });
});
