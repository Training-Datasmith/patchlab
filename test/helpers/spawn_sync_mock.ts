import type { SpawnSyncReturns } from 'node:child_process';

/** Minimal `spawnSync` return shape for unit tests that mock container validation. */
export function mock_spawn_sync_result(options: {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
} = {}): SpawnSyncReturns<string> {
    const stdout = options.stdout ?? '';
    const stderr = options.stderr ?? '';
    return {
        pid: 1,
        output: [null, stdout, stderr],
        stdout,
        stderr,
        status: options.status ?? 0,
        signal: null,
        error: options.error,
    };
}
