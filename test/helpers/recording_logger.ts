import { beforeEach, afterEach } from 'vitest';
import { ConsoleLogger, set_logger, type Logger } from '../../src/logger.js';

export interface Recorded_Call {
    method: 'result' | 'info' | 'warn' | 'error' | 'verbose';
    message: string | Error;
}

/**
 * Test helper implementing the `Logger` interface by capturing every call into
 * an in-memory array. Install via `set_logger(new RecordingLogger())` in
 * `beforeEach` and restore a fresh `ConsoleLogger` in `afterEach`, or call
 * `install_recording_logger_hooks()` which does both.
 */
export class RecordingLogger implements Logger {
    readonly calls: Recorded_Call[] = [];

    result(message: string): void {
        this.calls.push({ method: 'result', message });
    }

    info(message: string): void {
        this.calls.push({ method: 'info', message });
    }

    warn(message: string | Error): void {
        this.calls.push({ method: 'warn', message });
    }

    error(message: string | Error): void {
        this.calls.push({ method: 'error', message });
    }

    /**
     * `RecordingLogger.verbose` captures the call unconditionally — it does
     * NOT consult `PATCHLAB_VERBOSE` or the CLI override. Tests asserting
     * "the production code reached a `logger().verbose(...)` call site"
     * should NOT toggle the env var; tests exercising the activation gate
     * itself should use `ConsoleLogger` with stream spies or call
     * `is_verbose_mode_active` directly.
     */
    verbose(message: string): void {
        this.calls.push({ method: 'verbose', message });
    }

    clear(): void {
        this.calls.length = 0;
    }
}

export interface Recording_Logger_Handle {
    /** Return the recording logger active for the current test. */
    current: () => RecordingLogger;
}

/**
 * Register `beforeEach` / `afterEach` hooks that install a fresh
 * `RecordingLogger` for each test and restore a `ConsoleLogger` afterward.
 * Returns an accessor for the active recording logger; the underlying
 * instance is regenerated per test, so callers MUST go through `current()`
 * rather than caching the returned reference.
 *
 * Place this call at the top of a describe block to scope the hooks to just
 * that block; placing it at module scope applies to every test in the file.
 */
export function install_recording_logger_hooks(): Recording_Logger_Handle {
    let recording_logger = new RecordingLogger();

    beforeEach(() => {
        recording_logger = new RecordingLogger();
        set_logger(recording_logger);
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    return { current: () => recording_logger };
}

/**
 * Extract messages from a recording logger's `calls` array, filtered by
 * method. `Error` payloads are stringified via their `.message` field so
 * callers can use plain `toContain` / `toMatch` assertions.
 */
export function filter_recorded_messages(
    recording_logger: RecordingLogger,
    method: Recorded_Call['method'],
): string[] {
    return recording_logger.calls
        .filter((call) => call.method === method)
        .map((call) => (call.message instanceof Error ? call.message.message : call.message));
}
