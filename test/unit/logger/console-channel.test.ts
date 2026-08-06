import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleLogger } from '../../../src/logger.js';

describe('ConsoleLogger channel routing', () => {
    let stdout_spy: ReturnType<typeof vi.spyOn>;
    let stderr_spy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stdout_spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        stderr_spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    });

    afterEach(() => {
        stdout_spy.mockRestore();
        stderr_spy.mockRestore();
    });

    it('result writes to stdout, not stderr', () => {
        new ConsoleLogger().result('foo');

        expect(stdout_spy).toHaveBeenCalledWith('foo\n');
        expect(stderr_spy).not.toHaveBeenCalled();
    });

    it('info writes to stderr, not stdout', () => {
        new ConsoleLogger().info('foo');

        expect(stderr_spy).toHaveBeenCalledWith('foo\n');
        expect(stdout_spy).not.toHaveBeenCalled();
    });

    it('warn writes to stderr, not stdout', () => {
        new ConsoleLogger().warn('foo');

        expect(stderr_spy).toHaveBeenCalledWith('foo\n');
        expect(stdout_spy).not.toHaveBeenCalled();
    });

    it('error writes to stderr, not stdout', () => {
        new ConsoleLogger().error('foo');

        expect(stderr_spy).toHaveBeenCalledWith('foo\n');
        expect(stdout_spy).not.toHaveBeenCalled();
    });

    // Stream-redirection scenarios from spec.md "Channel convention":
    // these capture the property that an out/err redirect to a file collects
    // exactly the channel's emissions and nothing from the other channel.
    // We model "redirecting stream X to a file" by accumulating the writes
    // to the spy for stream X; the assertion that the OTHER stream's spy
    // saw nothing from a same-channel call is the redirect property in unit form.

    it('stdout-redirect captures only result emissions (no info/warn/error leakage)', () => {
        const console_logger = new ConsoleLogger();

        console_logger.result('row 1');
        console_logger.info('cache hit');
        console_logger.result('row 2');
        console_logger.warn('a warning');
        console_logger.error('an error');

        const captured_stdout = stdout_spy.mock.calls.map((call: unknown[]) => call[0] as string);
        expect(captured_stdout).toEqual(['row 1\n', 'row 2\n']);
    });

    it('stderr-redirect captures only info/warn/error emissions (no result leakage)', () => {
        const console_logger = new ConsoleLogger();

        console_logger.result('row 1');
        console_logger.info('cache hit');
        console_logger.result('row 2');
        console_logger.warn('a warning');
        console_logger.error('an error');

        const captured_stderr = stderr_spy.mock.calls.map((call: unknown[]) => call[0] as string);
        expect(captured_stderr).toEqual(['cache hit\n', 'a warning\n', 'an error\n']);
    });
});
