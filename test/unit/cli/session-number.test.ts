import { describe, it, expect } from 'vitest';
import { parse_session_number } from '../../../src/cli_arguments.js';

describe('parse_session_number', () => {
    it('accepts a plain positive integer string', () => {
        expect(parse_session_number('1')).toBe(1);
        expect(parse_session_number('42')).toBe(42);
    });

    it('rejects a decimal that would silently truncate to a valid session', () => {
        expect(() => parse_session_number('3.7')).toThrow(/--session/);
    });

    it('rejects a string with a trailing non-digit that parseInt would silently ignore', () => {
        expect(() => parse_session_number('3abc')).toThrow(/--session/);
    });

    it('rejects zero', () => {
        expect(() => parse_session_number('0')).toThrow(/--session/);
    });

    it('rejects a negative string', () => {
        expect(() => parse_session_number('-1')).toThrow(/--session/);
    });

    it('rejects the empty string', () => {
        expect(() => parse_session_number('')).toThrow(/--session/);
    });
});
