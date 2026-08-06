import { describe, it, expect } from 'vitest';
import {
    validate_validation_block,
    validate_launch_command,
    validate_extractable_artifacts,
} from '../../../../src/tools/configured_provider/artifacts.js';

const MANIFEST_NAME = 'aider';
const IMAGE_HOME = '/home/patchlab';

describe('validate_validation_block', () => {
    it('returns undefined when omitted', () => {
        expect(validate_validation_block(undefined)).toBeUndefined();
    });

    it('accepts a `{ command: [...] }` block', () => {
        expect(validate_validation_block({ command: ['aider', '--version'] }))
            .toEqual({ command: ['aider', '--version'] });
    });

    it('rejects non-mapping inputs', () => {
        expect(() => validate_validation_block('command')).toThrow(/must be a mapping/);
        expect(() => validate_validation_block([])).toThrow(/must be a mapping/);
    });

    it('rejects missing or non-array command', () => {
        expect(() => validate_validation_block({})).toThrow(/required when validation is set/);
        expect(() => validate_validation_block({ command: 'aider' })).toThrow(/list of strings/);
    });

    it('rejects empty command list', () => {
        expect(() => validate_validation_block({ command: [] })).toThrow(/non-empty when validation is set/);
    });

    it('rejects non-string command tokens', () => {
        expect(() => validate_validation_block({ command: ['ok', 1] })).toThrow();
    });

    it('rejects unknown sibling fields', () => {
        expect(() => validate_validation_block({ command: ['ok'], extra: true })).toThrow(/unknown field/);
    });
});

describe('validate_launch_command', () => {
    it('accepts a non-empty list of strings', () => {
        expect(validate_launch_command(['aider', '--no-color'])).toEqual(['aider', '--no-color']);
    });

    it('rejects non-array inputs', () => {
        expect(() => validate_launch_command('aider')).toThrow(/list of strings/);
        expect(() => validate_launch_command(undefined)).toThrow(/list of strings/);
    });

    it('rejects an empty list (execve requires argv[0])', () => {
        expect(() => validate_launch_command([])).toThrow(/non-empty/);
    });

    it('rejects non-string entries', () => {
        expect(() => validate_launch_command(['aider', 42])).toThrow();
    });
});

describe('validate_extractable_artifacts', () => {
    function valid_entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            name: 'chat-log',
            container_path: '/home/patchlab/.chat.log',
            type: 'file',
            archive_subpath: 'chat.log',
            required_for_resume: false,
            ...overrides,
        };
    }

    it('returns [] when omitted', () => {
        expect(validate_extractable_artifacts(undefined, MANIFEST_NAME, IMAGE_HOME)).toEqual([]);
    });

    it('returns [] when given an empty list', () => {
        expect(validate_extractable_artifacts([], MANIFEST_NAME, IMAGE_HOME)).toEqual([]);
    });

    it('rejects non-array inputs', () => {
        expect(() => validate_extractable_artifacts({}, MANIFEST_NAME, IMAGE_HOME))
            .toThrow(/list of mappings/);
    });

    it('accepts a well-formed single entry', () => {
        const result = validate_extractable_artifacts(
            [valid_entry()],
            MANIFEST_NAME,
            IMAGE_HOME,
        );
        expect(result).toEqual([{
            name: 'chat-log',
            container_path: '/home/patchlab/.chat.log',
            type: 'file',
            archive_subpath: 'chat.log',
            required_for_resume: false,
        }]);
    });

    it('rejects non-mapping entries with the indexed field path', () => {
        let field_path: string | undefined;
        try {
            validate_extractable_artifacts(['nope'], MANIFEST_NAME, IMAGE_HOME);
        } catch (error) {
            field_path = (error as { field_path?: string }).field_path;
        }
        expect(field_path).toBe('extractable_artifacts[0]');
    });

    it('rejects entries missing or with invalid name/type/archive_subpath', () => {
        expect(() => validate_extractable_artifacts([valid_entry({ name: '' })], MANIFEST_NAME, IMAGE_HOME))
            .toThrow();
        expect(() => validate_extractable_artifacts([valid_entry({ type: 'symbolic_link' })], MANIFEST_NAME, IMAGE_HOME))
            .toThrow();
        expect(() => validate_extractable_artifacts([valid_entry({ archive_subpath: 123 })], MANIFEST_NAME, IMAGE_HOME))
            .toThrow();
    });

    it('rejects required_for_resume that is not a strict boolean', () => {
        expect(() => validate_extractable_artifacts(
            [valid_entry({ required_for_resume: 'true' })],
            MANIFEST_NAME,
            IMAGE_HOME,
        )).toThrow(/YAML boolean/);
    });

    it('rejects unknown fields in an entry', () => {
        expect(() => validate_extractable_artifacts(
            [valid_entry({ stray: 'value' })],
            MANIFEST_NAME,
            IMAGE_HOME,
        )).toThrow(/unknown field/);
    });

    it('rejects duplicate archive_subpath', () => {
        const entries = [
            valid_entry({ name: 'a', archive_subpath: 'shared' }),
            valid_entry({ name: 'b', archive_subpath: 'shared' }),
        ];
        expect(() => validate_extractable_artifacts(entries, MANIFEST_NAME, IMAGE_HOME)).toThrow();
    });

    it('rejects duplicate name', () => {
        const entries = [
            valid_entry({ name: 'shared', archive_subpath: 'a' }),
            valid_entry({ name: 'shared', archive_subpath: 'b' }),
        ];
        expect(() => validate_extractable_artifacts(entries, MANIFEST_NAME, IMAGE_HOME)).toThrow();
    });
});
