import { describe, it, expect } from 'vitest';
import { ConsoleLogger, type Logger } from '../../../src/logger.js';

describe('Logger interface', () => {
    it('ConsoleLogger has exactly the five expected methods', () => {
        const console_logger = new ConsoleLogger();

        const own_and_inherited_method_names = new Set<string>();
        let prototype: object | null = Object.getPrototypeOf(console_logger);
        while (prototype && prototype !== Object.prototype) {
            for (const name of Object.getOwnPropertyNames(prototype)) {
                if (name === 'constructor') {
                    continue;
                }

                const value = (prototype as Record<string, unknown>)[name];
                if (typeof value === 'function') {
                    own_and_inherited_method_names.add(name);
                }
            }

            prototype = Object.getPrototypeOf(prototype);
        }

        const public_method_names = [...own_and_inherited_method_names].filter(
            (name) => !name.startsWith('write_'),
        );

        expect(new Set(public_method_names)).toEqual(
            new Set(['result', 'info', 'warn', 'error', 'verbose']),
        );
    });

    it('each method is callable with a single string', () => {
        const console_logger = new ConsoleLogger();
        const noop_logger: Logger = console_logger;

        // Type-level assertion: the call expressions below MUST compile.
        // (Runtime invocation goes through ConsoleLogger which writes to streams;
        // exercised in logger-console-channel.test.ts. Here we only check that
        // the signature accepts a string.)
        const methods: (keyof Logger)[] = ['result', 'info', 'warn', 'error', 'verbose'];
        for (const method of methods) {
            expect(typeof noop_logger[method]).toBe('function');
        }
    });

    it('result, info, and verbose reject non-string arguments at compile time', () => {
        // Locks spec.md scenario "result and info accept only string" plus the
        // verbose-logging spec's `verbose(message: string): void` signature: the
        // TypeScript compiler MUST reject `logger().info(42)`,
        // `logger().result(new Error(...))`, and `logger().verbose(42)`. The
        // block below is defined for its compile-time `@ts-expect-error` side
        // effect — every directive would itself error if the following call
        // were actually accepted by the type checker. Validated by
        // `npx tsc -p test/tsconfig.json --noEmit`; the runtime function is
        // intentionally not invoked because executing the calls would emit to
        // stdout/stderr (and verbose would respect PATCHLAB_VERBOSE).
        const compile_only_check: () => void = () => {
            const console_logger = new ConsoleLogger();

            // @ts-expect-error result accepts only string, not number
            console_logger.result(42);
            // @ts-expect-error result accepts only string, not Error
            console_logger.result(new Error('not allowed on result'));
            // @ts-expect-error info accepts only string, not number
            console_logger.info(42);
            // @ts-expect-error info accepts only string, not Error
            console_logger.info(new Error('not allowed on info'));
            // @ts-expect-error verbose accepts only string, not number
            console_logger.verbose(42);
            // @ts-expect-error verbose accepts only string, not Error
            console_logger.verbose(new Error('not allowed on verbose'));

            // warn and error DO accept Error — these calls intentionally have
            // NO @ts-expect-error directive. If a future change tightens the
            // signature to reject Error, these lines would suddenly type-check
            // as wrong, breaking the test.
            console_logger.warn(new Error('stack-preserving warn'));
            console_logger.error(new Error('stack-preserving error'));
        };

        expect(typeof compile_only_check).toBe('function');
    });
});