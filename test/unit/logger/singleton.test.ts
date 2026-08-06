import { describe, it, expect, afterEach } from 'vitest';
import { ConsoleLogger, logger, set_logger, type Logger } from '../../../src/logger.js';
import { RecordingLogger } from '../../helpers/recording_logger.js';

describe('Logger singleton with set_logger', () => {
    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    it('default logger() returns a ConsoleLogger', () => {
        expect(logger()).toBeInstanceOf(ConsoleLogger);
    });

    it('set_logger replaces the active singleton', () => {
        const recording = new RecordingLogger();
        set_logger(recording);

        expect(logger()).toBe(recording);

        logger().info('hello');
        expect(recording.calls).toEqual([{ method: 'info', message: 'hello' }]);
    });

    it('logger() reads the current reference (no stale capture)', () => {
        // Simulate a module that captured `logger` (the function) at file-load
        // time and invokes it after a later swap.
        const captured_accessor = logger;

        const recording_one = new RecordingLogger();
        set_logger(recording_one);
        captured_accessor().info('first');

        const recording_two = new RecordingLogger();
        set_logger(recording_two);
        captured_accessor().info('second');

        expect(recording_one.calls).toEqual([{ method: 'info', message: 'first' }]);
        expect(recording_two.calls).toEqual([{ method: 'info', message: 'second' }]);
    });

    it('restoring a fresh ConsoleLogger in afterEach prevents inter-test leakage', () => {
        // Sanity check: after the previous test's `set_logger(recording_two)`
        // ran, the outer afterEach should have already restored ConsoleLogger.
        // (This assertion runs BEFORE the local afterEach for this test.)
        expect(logger()).toBeInstanceOf(ConsoleLogger);
    });

    it('a custom Logger implementation does not need to extend ConsoleLogger', () => {
        const calls: string[] = [];
        const custom: Logger = {
            result: (message) => calls.push(`result:${message}`),
            info: (message) => calls.push(`info:${message}`),
            warn: (message) => calls.push(`warn:${String(message)}`),
            error: (message) => calls.push(`error:${String(message)}`),
            verbose: (message) => calls.push(`verbose:${message}`),
        };
        set_logger(custom);

        logger().result('r');
        logger().info('i');
        logger().warn('w');
        logger().error('e');
        logger().verbose('v');

        expect(calls).toEqual(['result:r', 'info:i', 'warn:w', 'error:e', 'verbose:v']);
    });
});
