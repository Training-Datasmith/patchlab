import { describe, it, expect } from 'vitest';
import { get_provider, list_providers } from '../../../src/tools/index.js';

describe('built-in provider registry at module load', () => {
    it('registers no built-in providers at module load', () => {
        expect(list_providers()).toEqual([]);
    });

    it('rejects lookup of removed built-ins', () => {
        expect(() => get_provider('gemini-cli-oauth')).toThrow(/gemini-cli-oauth/);
        expect(() => get_provider('gemini-cli-api')).toThrow(/gemini-cli-api/);
        expect(() => get_provider('claude-code')).toThrow(/claude-code/);
    });
});
