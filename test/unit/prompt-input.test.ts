import { describe, it, expect } from 'vitest';
import { resolve_prompt_text, Prompt_Input_Error } from '../../src/prompt_input.js';

describe('resolve_prompt_text', () => {
    it('returns undefined when raw is undefined', () => {
        expect(resolve_prompt_text(undefined)).toBeUndefined();
    });

    it('returns non-empty strings unchanged', () => {
        expect(resolve_prompt_text('Add tests')).toBe('Add tests');
        expect(resolve_prompt_text('-fix bug')).toBe('-fix bug');
    });

    it('reads stdin for true and preserves trailing newline', () => {
        expect(resolve_prompt_text(true, {
            is_tty: () => false,
            read_stdin: () => 'hello\n',
        })).toBe('hello\n');
    });

    it('reads stdin for the - sentinel', () => {
        expect(resolve_prompt_text('-', {
            is_tty: () => false,
            read_stdin: () => 'piped prompt',
        })).toBe('piped prompt');
    });

    it('throws on TTY when stdin would be read', () => {
        expect(() => resolve_prompt_text(true, { is_tty: () => true }))
            .toThrow(Prompt_Input_Error);
    });
});
