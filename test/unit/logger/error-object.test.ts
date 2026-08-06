import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger } from '../../../src/logger.js';

describe('ConsoleLogger Error-object rendering', () => {
    let stderr_spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stderr_spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    });

    afterEach(() => {
        stderr_spy.mockRestore();
    });

    it('error(Error) emits message and stack trace in a single stderr write', () => {
        new ConsoleLogger().error(new Error('boom'));

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        const payload = stderr_spy.mock.calls[0][0] as string;
        expect(payload).toContain('boom');
        expect(payload).toContain('at ');
        expect(payload).toMatch(/\.test\.ts/);
        expect(payload.endsWith('\n')).toBe(true);
    });

    it('warn(Error) emits message and stack trace in a single stderr write', () => {
        new ConsoleLogger().warn(new Error('uh oh'));

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        const payload = stderr_spy.mock.calls[0][0] as string;
        expect(payload).toContain('uh oh');
        expect(payload).toContain('at ');
        expect(payload.endsWith('\n')).toBe(true);
    });

    it('Error with no stack falls back to String(error) plus newline', () => {
        class Stack_Less_Error extends Error {
            constructor(message: string) {
                super(message);
                this.stack = undefined;
            }
        }
        const stack_less = new Stack_Less_Error('no stack here');

        new ConsoleLogger().error(stack_less);

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        const payload = stderr_spy.mock.calls[0][0] as string;
        expect(payload).toBe(`${String(stack_less)}\n`);
    });

    it('error("string") uses the standard trailing-newline rule (no Error path)', () => {
        new ConsoleLogger().error('regular string');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('regular string\n');
    });

    it('warn("string") uses the standard trailing-newline rule (no Error path)', () => {
        new ConsoleLogger().warn('plain warning');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('plain warning\n');
    });
});
