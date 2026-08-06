import { describe, it, expect } from 'vitest';
import { validate_authentication } from '../../../../src/tools/configured_provider/authentication.js';

const MANIFEST_DIRECTORY = '/repo/.patchlab/tools';
const HOME_RESOLVER = (): string => '/home/dev';

function validate(raw: unknown, homedir_resolver: () => string | null = HOME_RESOLVER): unknown {
    return validate_authentication(raw, MANIFEST_DIRECTORY, homedir_resolver);
}

function capture_field_path(thunk: () => unknown): string | undefined {
    try {
        thunk();
    } catch (error) {
        return (error as { field_path?: string }).field_path;
    }

    return undefined;
}

describe('validate_authentication — top-level shape', () => {
    it('rejects non-mapping inputs', () => {
        expect(() => validate(null)).toThrow(/must be a mapping/);
        expect(() => validate([])).toThrow(/must be a mapping/);
        expect(() => validate('none')).toThrow(/must be a mapping/);
    });

    it('rejects unknown methods', () => {
        expect(() => validate({ method: 'oauth' })).toThrow(/must be one of/);
        expect(() => validate({ method: undefined })).toThrow(/must be one of/);
    });
});

describe("validate_authentication — method 'none'", () => {
    it('accepts a bare `{ method: "none" }`', () => {
        expect(validate({ method: 'none' })).toEqual({ method: 'none' });
    });

    it('rejects extra fields when method=none', () => {
        expect(() => validate({ method: 'none', variable_names: [] })).toThrow(/not allowed when method=none/);
    });
});

describe("validate_authentication — method 'environment_variables'", () => {
    it('accepts a non-empty variable_names list', () => {
        expect(validate({ method: 'environment_variables', variable_names: ['API_KEY'] }))
            .toEqual({ method: 'environment_variables', variable_names: ['API_KEY'] });
    });

    it('rejects missing variable_names', () => {
        expect(() => validate({ method: 'environment_variables' })).toThrow(/required when method=environment_variables/);
    });

    it('rejects non-array variable_names', () => {
        expect(() => validate({ method: 'environment_variables', variable_names: 'API_KEY' }))
            .toThrow(/list of strings/);
    });

    it('rejects an empty variable_names list', () => {
        expect(() => validate({ method: 'environment_variables', variable_names: [] }))
            .toThrow(/at least one variable/);
    });

    it('rejects non-string and empty-string entries', () => {
        expect(() => validate({ method: 'environment_variables', variable_names: [42] }))
            .toThrow(/non-empty string/);
        expect(() => validate({ method: 'environment_variables', variable_names: [''] }))
            .toThrow(/non-empty string/);
    });
});

describe("validate_authentication — method 'file_copy'", () => {
    it('accepts a non-empty copies list and flags home-expansion', () => {
        const result = validate({
            method: 'file_copy',
            copies: [
                { host: '~/.config/app', container: '/home/patchlab/.config/app' },
                { host: '/etc/host.json', container: '/etc/in.json' },
            ],
        }) as { method: string; copies: { host: string; container: string; uses_home_expansion: boolean }[] };
        expect(result.method).toBe('file_copy');
        expect(result.copies).toHaveLength(2);
        // First entry: ~ home-expansion → uses_home_expansion=true; host expands relative to resolved $HOME.
        expect(result.copies[0].uses_home_expansion).toBe(true);
        expect(result.copies[0].container).toBe('/home/patchlab/.config/app');
        // Second entry: absolute host path → no home expansion.
        expect(result.copies[1].uses_home_expansion).toBe(false);
    });

    it('rejects missing copies', () => {
        expect(() => validate({ method: 'file_copy' })).toThrow(/required when method=file_copy/);
    });

    it('rejects an empty copies list', () => {
        expect(() => validate({ method: 'file_copy', copies: [] })).toThrow(/required when method=file_copy/);
    });

    it('rejects non-mapping copy entries', () => {
        expect(() => validate({ method: 'file_copy', copies: ['string-entry'] }))
            .toThrow(/must be a mapping with `host` and `container`/);
    });

    it('rejects missing or empty host/container with the correct field_path', () => {
        const missing_host = capture_field_path(() =>
            validate({ method: 'file_copy', copies: [{ container: '/x' }] }));
        expect(missing_host).toBe('authentication.copies[0].host');

        const empty_container = capture_field_path(() =>
            validate({ method: 'file_copy', copies: [{ host: '/h', container: '' }] }));
        expect(empty_container).toBe('authentication.copies[0].container');
    });

    it('flags $HOME prefix as home-expansion', () => {
        const result = validate({
            method: 'file_copy',
            copies: [{ host: '$HOME/.creds', container: '/c/.creds' }],
        }) as { copies: { uses_home_expansion: boolean }[] };
        expect(result.copies[0].uses_home_expansion).toBe(true);
    });
});
