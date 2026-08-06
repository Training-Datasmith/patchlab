import { describe, it, expect } from 'vitest';
import {
    assert_parsed_object_root,
    require_string_field,
    require_number_field,
    validate_string_or_null_map,
    is_plain_object,
    validate_optional_string_field,
    validate_optional_string_array_field,
    validate_optional_string_record_field,
} from '../../src/json_validators.js';

const FILE_PATH = '/fake/path/manifest.json';

describe('assert_parsed_object_root', () => {
    it('returns the value when it is a plain object', () => {
        const value = { a: 1 };
        expect(assert_parsed_object_root(value, FILE_PATH)).toBe(value);
    });

    it('returns the value for an empty object', () => {
        const value = {};
        expect(assert_parsed_object_root(value, FILE_PATH)).toBe(value);
    });

    it.each([
        ['null', null, 'null'],
        ['array', [1, 2, 3], 'array'],
        ['string', 'foo', 'string'],
        ['number', 42, 'number'],
        ['boolean', true, 'boolean'],
    ])('throws on %s', (_label, input, expected_type) => {
        try {
            assert_parsed_object_root(input, FILE_PATH);
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain(FILE_PATH);
            expect(message).toContain(expected_type);
        }
    });
});

describe('require_string_field', () => {
    it('returns the string value when present', () => {
        expect(require_string_field({ id: 'abc' }, 'id', FILE_PATH)).toBe('abc');
    });

    it('returns the empty string when present', () => {
        // Empty string is a string — the validator checks the type, not emptiness.
        expect(require_string_field({ id: '' }, 'id', FILE_PATH)).toBe('');
    });

    it('throws when the field is absent, naming the field and file', () => {
        try {
            require_string_field({}, 'id', FILE_PATH);
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain(FILE_PATH);
            expect(message).toContain('id');
            expect(message).toContain('undefined');
        }
    });

    it.each([
        ['null', null, 'null'],
        ['number', 42, 'number'],
        ['boolean', false, 'boolean'],
        ['array', ['a'], 'array'],
        ['object', { nested: true }, 'object'],
    ])('throws when the field is %s', (_label, value, expected_type) => {
        try {
            require_string_field({ id: value }, 'id', FILE_PATH);
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('id');
            expect(message).toContain(expected_type);
        }
    });
});

describe('require_number_field', () => {
    it('returns the number value when present', () => {
        expect(require_number_field({ n: 7 }, 'n', FILE_PATH)).toBe(7);
    });

    it('returns 0 (zero is a finite number)', () => {
        expect(require_number_field({ n: 0 }, 'n', FILE_PATH)).toBe(0);
    });

    it('throws when the field is absent', () => {
        expect(() => require_number_field({}, 'session_number', FILE_PATH))
            .toThrow(/session_number.*finite number/);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('throws on non-finite number %s', (_label, value) => {
        expect(() => require_number_field({ n: value }, 'n', FILE_PATH))
            .toThrow(/finite number/);
    });

    it.each([
        ['string', '42'],
        ['null', null],
        ['boolean', true],
    ])('throws when the field is %s', (_label, value) => {
        expect(() => require_number_field({ n: value }, 'n', FILE_PATH))
            .toThrow(/finite number/);
    });
});

describe('validate_string_or_null_map', () => {
    it('returns undefined when the field is absent', () => {
        expect(validate_string_or_null_map(undefined, 'commit_shas', FILE_PATH)).toBeUndefined();
    });

    it('returns undefined when the field is explicit null', () => {
        // Legacy synthesis distinguishes "absent" from "present" — `null` is
        // tolerated as a missing-equivalent here so the caller falls through.
        expect(validate_string_or_null_map(null, 'commit_shas', FILE_PATH)).toBeUndefined();
    });

    it('returns an empty map unchanged', () => {
        const map = {};
        expect(validate_string_or_null_map(map, 'commit_shas', FILE_PATH)).toBe(map);
    });

    it('returns a well-shaped map unchanged', () => {
        const map = { '/repo/a': 'abc123', '/repo/b': null };
        expect(validate_string_or_null_map(map, 'commit_shas', FILE_PATH)).toBe(map);
    });

    it('throws when the value is an array', () => {
        try {
            validate_string_or_null_map(['/repo/a'], 'commit_shas', FILE_PATH);
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain(FILE_PATH);
            expect(message).toContain('commit_shas');
            expect(message).toContain('array');
        }
    });

    it('throws when the value is a primitive', () => {
        expect(() => validate_string_or_null_map('oops', 'commit_shas', FILE_PATH))
            .toThrow(/commit_shas.*string/);
    });

    it('throws when an entry value is a number, naming the bad key', () => {
        try {
            validate_string_or_null_map(
                { '/repo/a': 42 },
                'commit_shas',
                FILE_PATH,
            );
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('commit_shas');
            expect(message).toContain('/repo/a');
            expect(message).toContain('number');
        }
    });

    it('throws when an entry value is an object', () => {
        expect(() => validate_string_or_null_map(
            { '/repo/a': { nested: 'sha' } },
            'commit_shas',
            FILE_PATH,
        )).toThrow(/object/);
    });
});

describe('is_plain_object', () => {
    it('accepts plain objects and rejects arrays and primitives', () => {
        expect(is_plain_object({})).toBe(true);
        expect(is_plain_object({ a: 1 })).toBe(true);
        expect(is_plain_object([])).toBe(false);
        expect(is_plain_object(null)).toBe(false);
        expect(is_plain_object('text')).toBe(false);
    });
});

describe('validate_optional_string_field', () => {
    it('returns undefined when absent and the string when present', () => {
        expect(validate_optional_string_field({}, 'tool', FILE_PATH)).toBeUndefined();
        expect(validate_optional_string_field({ tool: 'gemini-cli-oauth' }, 'tool', FILE_PATH))
            .toBe('gemini-cli-oauth');
    });

    it('throws when present but not a string', () => {
        expect(() => validate_optional_string_field({ tool: 1 }, 'tool', FILE_PATH))
            .toThrow(/optional field "tool"/);
    });
});

describe('validate_optional_string_array_field', () => {
    it('returns undefined when absent and the array when present', () => {
        expect(validate_optional_string_array_field({}, 'tags', FILE_PATH)).toBeUndefined();
        expect(validate_optional_string_array_field({ tags: ['a', 'b'] }, 'tags', FILE_PATH))
            .toEqual(['a', 'b']);
    });

    it('throws when elements are not strings', () => {
        expect(() => validate_optional_string_array_field({ tags: [1] }, 'tags', FILE_PATH))
            .toThrow(/elements must be strings/);
    });
});

describe('validate_optional_string_record_field', () => {
    it('returns undefined when absent and the record when present', () => {
        expect(validate_optional_string_record_field({}, 'labels', FILE_PATH)).toBeUndefined();
        expect(validate_optional_string_record_field({ labels: { a: '1' } }, 'labels', FILE_PATH))
            .toEqual({ a: '1' });
    });

    it('throws when values are not strings', () => {
        expect(() => validate_optional_string_record_field({ labels: { a: 1 } }, 'labels', FILE_PATH))
            .toThrow(/values must be strings/);
    });
});
