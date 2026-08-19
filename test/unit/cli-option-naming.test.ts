/**
 * Locks `apply_snake_case_option_naming` — the monkey-patch that makes Commander
 * key parsed options in snake_case instead of camelCase (see
 * src/cli_option_naming.ts). This is the safety net the patch's own doc points
 * at: it patches a third-party prototype, so a Commander upgrade that renames or
 * changes the contract of `Option.prototype.attributeName` would silently revert
 * every option key to camelCase and reintroduce the class of bug where a handler
 * reads `options.older_than` but Commander wrote `options.olderThan`. These
 * assertions turn that silent reversion into a loud failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command, Option } from 'commander';
import { apply_snake_case_option_naming } from '../../src/cli_option_naming.js';

// Capture before patching so the global prototype is restored for other tests
// sharing this worker (no test depends on camelCase keys, but leave no trace).
const original_attribute_name = Option.prototype.attributeName;

describe('apply_snake_case_option_naming', () => {
    beforeAll(() => {
        apply_snake_case_option_naming();
    });

    afterAll(() => {
        Option.prototype.attributeName = original_attribute_name;
    });

    it('derives snake_case attribute keys for multi-word flags', () => {
        expect(new Option('--older-than <days>').attributeName()).toBe('older_than');
        expect(new Option('--allow-untrusted-manifests').attributeName())
            .toBe('allow_untrusted_manifests');
        expect(new Option('--allow-untrusted-default-tool').attributeName())
            .toBe('allow_untrusted_default_tool');
    });

    it('leaves single-word flags unchanged', () => {
        expect(new Option('--force').attributeName()).toBe('force');
    });

    it('strips the no- prefix on negated flags before snake-casing (matching Commander)', () => {
        expect(new Option('--no-install').attributeName()).toBe('install');
        expect(new Option('--no-dry-run').attributeName()).toBe('dry_run');
    });

    it('parses a real command into snake_case option keys, never camelCase', () => {
        const seen: Record<string, unknown> = {};
        const program = new Command();
        program
            .command('gc')
            .option('--older-than <days>', 'remove sandboxes older than N days', Number.parseInt)
            .option('--dry-run', 'preview only')
            .action((options) => {
                Object.assign(seen, options);
            });

        program.parse(['node', 'patchlab', 'gc', '--older-than', '30', '--dry-run']);

        expect(seen).toMatchObject({ older_than: 30, dry_run: true });
        // The exact bug this guards: Commander's default camelCase keys must be absent.
        expect(seen).not.toHaveProperty('olderThan');
        expect(seen).not.toHaveProperty('dryRun');
    });
});
