import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command, Option } from 'commander';
import { apply_snake_case_option_naming } from '../../../src/cli_option_naming.js';
import { collect_passthrough } from '../../../src/cli_arguments.js';

const original_attribute_name = Option.prototype.attributeName;

describe('create --passthrough Commander parsing', () => {
    beforeAll(() => {
        apply_snake_case_option_naming();
    });

    afterAll(() => {
        Option.prototype.attributeName = original_attribute_name;
    });

    it('parses equals-form hyphen tokens as passthrough argv', () => {
        const seen: { passthrough?: string[] } = {};
        const program = new Command();
        program
            .command('create')
            .argument('[source]')
            .option(
                '--passthrough <token>',
                'Forward an argv token to the tool launch command',
                collect_passthrough,
                [] as string[],
            )
            .action((_source, options) => {
                seen.passthrough = options.passthrough;
            });

        program.parse([
            'node', 'patchlab', 'create', '.',
            '--passthrough=--format',
            '--passthrough', 'json',
        ]);

        expect(seen.passthrough).toEqual(['--format', 'json']);
    });
});
