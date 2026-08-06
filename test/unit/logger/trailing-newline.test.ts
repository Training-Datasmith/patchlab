import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger } from '../../../src/logger.js';

describe('ConsoleLogger trailing-newline rule', () => {
    let stderr_spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stderr_spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    });

    afterEach(() => {
        stderr_spy.mockRestore();
    });

    it('appends a newline when the message does not end with one', () => {
        new ConsoleLogger().info('hello');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('hello\n');
    });

    it('leaves a message ending in a newline unchanged', () => {
        new ConsoleLogger().info('hello\n');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('hello\n');
    });

    it('preserves embedded newlines and appends a final one', () => {
        new ConsoleLogger().info('line 1\nline 2');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('line 1\nline 2\n');
    });

    it('does not double-newline a multi-line message that already ends with one', () => {
        new ConsoleLogger().info('line 1\nline 2\n');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('line 1\nline 2\n');
    });

    it('emits exactly one newline for the empty string', () => {
        new ConsoleLogger().info('');

        expect(stderr_spy).toHaveBeenCalledTimes(1);
        expect(stderr_spy).toHaveBeenCalledWith('\n');
    });
});
