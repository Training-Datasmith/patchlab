import { defineConfig } from 'vitest/config';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const shared = {
    env: {
        GIT_AUTHOR_NAME: 'patchlab-test',
        GIT_AUTHOR_EMAIL: 'test@patchlab.local',
        GIT_COMMITTER_NAME: 'patchlab-test',
        GIT_COMMITTER_EMAIL: 'test@patchlab.local',
    },
    testTimeout: 120_000,
    hookTimeout: 60_000,
} as const;

export default defineConfig({
    // Keep Vite's transform cache outside node_modules to prevent stale
    // cache errors on Windows ("Cannot read properties of undefined
    // (reading 'config')") that occur when the cache is invalidated by
    // code changes or npm operations.
    cacheDir: join(tmpdir(), 'patchlab-vitest-cache'),
    // Disable the dependency optimizer — its mid-run stale checks can
    // cause "Cannot read properties of undefined (reading 'config')"
    // crashes on Windows, especially during heavy integration tests.
    optimizeDeps: { disabled: true },
    test: {
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
        },
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['test/unit/**/*.test.ts'],
                    ...shared,
                },
            },
            {
                test: {
                    name: 'integration',
                    include: ['test/integration/**/*.test.ts'],
                    setupFiles: ['test/integration/setup-podman.ts'],
                    fileParallelism: false,
                    ...shared,
                },
            },
            {
                // POSIX-only assertions (fifo/socket types, case-sensitive
                // `.YAML` vs `.yaml`, unprivileged symlinks). Run with
                // `npm run test:posix`, which executes this project inside
                // a Linux container. NOT included in the default `npm test`
                // run because it's a no-op on Windows hosts.
                test: {
                    name: 'posix',
                    include: ['test/posix/**/*.test.ts'],
                    ...shared,
                },
            },
            {
                // Windows-only assertions (NTFS junctions / reparse points,
                // drive-letter handling, separator-mixing on Windows-shaped
                // paths). Each test self-gates with `process.platform !==
                // 'win32'` so the project is a no-op on POSIX hosts. Run via
                // `npm test` on a Windows host; runs inert on Linux/macOS.
                test: {
                    name: 'windows',
                    include: ['test/windows/**/*.test.ts'],
                    ...shared,
                },
            },
        ],
    },
});
