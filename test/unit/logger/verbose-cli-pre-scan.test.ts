/**
 * Argv pre-scan in isolation. The function `argv_contains_verbose_flag` is
 * called by `src/cli.ts` BEFORE Commander's `parse()` runs to set the verbose
 * CLI override. Tested without spawning the CLI so the scan logic can be
 * verified directly (positional separator, position-insensitivity, etc.).
 */
import { describe, it, expect } from 'vitest';
import { argv_contains_verbose_flag } from '../../../src/logger.js';

describe('argv_contains_verbose_flag', () => {
    it('activates when --verbose appears before the subcommand', () => {
        expect(argv_contains_verbose_flag(['node', 'patchlab', '--verbose', 'create'])).toBe(true);
    });

    it('activates when --verbose appears after the subcommand', () => {
        expect(argv_contains_verbose_flag(['node', 'patchlab', 'create', '--verbose'])).toBe(true);
    });

    it('activates when --verbose appears after positional arguments', () => {
        expect(argv_contains_verbose_flag(['node', 'patchlab', 'create', './src', '--verbose'])).toBe(true);
    });

    it('does NOT activate when --verbose appears after the -- positional separator', () => {
        // Matches Commander's end-of-options convention: tokens after `--` are
        // positional, not options. A literal `--verbose` passed as a positional
        // arg (e.g. to a future subcommand that accepts arbitrary strings)
        // must not trigger the override.
        expect(argv_contains_verbose_flag(['node', 'patchlab', 'create', '--', '--verbose'])).toBe(false);
    });

    it('does NOT activate when --verbose is absent', () => {
        expect(argv_contains_verbose_flag(['node', 'patchlab', 'create'])).toBe(false);
    });

    it('does NOT activate for empty argv', () => {
        expect(argv_contains_verbose_flag([])).toBe(false);
    });

    it('does NOT activate for value-forms like --verbose=true', () => {
        // Commander's standard boolean-option parsing rejects `--verbose=true`
        // anyway; the pre-scan matches only the exact bare token.
        expect(argv_contains_verbose_flag(['node', 'patchlab', '--verbose=true', 'create'])).toBe(false);
    });

    it('does NOT activate for the prefix --verbosely or --verbose-foo', () => {
        expect(argv_contains_verbose_flag(['node', 'patchlab', '--verbosely'])).toBe(false);
        expect(argv_contains_verbose_flag(['node', 'patchlab', '--verbose-foo'])).toBe(false);
    });

    it('activates when --verbose appears multiple times', () => {
        expect(argv_contains_verbose_flag(['node', 'patchlab', '--verbose', 'create', '--verbose'])).toBe(true);
    });

    it('does NOT activate when --verbose appears only after a -- earlier in argv', () => {
        // Even though --verbose exists later, scan stops at the first --.
        expect(argv_contains_verbose_flag(['node', 'patchlab', 'create', '--', 'arg1', '--verbose'])).toBe(false);
    });
});
