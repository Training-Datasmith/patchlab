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

const integration_project = {
    setupFiles: ['test/integration/set-up-podman.ts'],
    fileParallelism: false,
    ...shared,
} as const;

const integration_nerdctl_project = {
    setupFiles: [
        'test/integration/set-up-podman.ts',
        'test/integration/set-up-required-runtime.ts',
    ],
    fileParallelism: false,
    env: {
        ...shared.env,
        PATCHLAB_CONTAINER_RUNTIME: 'nerdctl',
        PATCHLAB_REQUIRED_CONTAINER_RUNTIME: 'nerdctl',
    },
    testTimeout: shared.testTimeout,
    hookTimeout: shared.hookTimeout,
} as const;

const integration_podman_project = {
    setupFiles: [
        'test/integration/set-up-podman.ts',
        'test/integration/set-up-required-runtime.ts',
    ],
    fileParallelism: false,
    env: {
        ...shared.env,
        PATCHLAB_CONTAINER_RUNTIME: 'podman',
        PATCHLAB_REQUIRED_CONTAINER_RUNTIME: 'podman',
    },
    testTimeout: shared.testTimeout,
    hookTimeout: shared.hookTimeout,
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
                    env: {
                        ...shared.env,
                        // Mocked unit tests assert podman argv shape; pin the
                        // runtime so auto-detect does not resolve nerdctl on macOS.
                        PATCHLAB_CONTAINER_RUNTIME: 'podman',
                    },
                    testTimeout: shared.testTimeout,
                    hookTimeout: shared.hookTimeout,
                },
            },
            {
                test: {
                    name: 'integration',
                    include: ['test/integration/**/*.test.ts'],
                    exclude: ['test/integration/podman/**', 'test/integration/nerdctl/**'],
                    ...integration_project,
                },
            },
            {
                test: {
                    name: 'integration-podman',
                    include: ['test/integration/podman/**/*.test.ts'],
                    ...integration_podman_project,
                },
            },
            {
                test: {
                    name: 'integration-nerdctl',
                    include: ['test/integration/nerdctl/**/*.test.ts'],
                    ...integration_nerdctl_project,
                },
            },
            {
                // POSIX-only assertions (fifo/socket types, case-sensitive
                // `.YAML` vs `.yaml`, unprivileged symlinks). Run with
                // `npm run test:posix`, which executes this project inside
                // a Linux container on Windows and macOS hosts. On Linux,
                // `npm test` runs this project natively.
                test: {
                    name: 'posix',
                    include: ['test/posix/**/*.test.ts'],
                    ...shared,
                },
            },
            {
                // Windows-only assertions (NTFS junctions / reparse points,
                // drive-letter handling, separator-mixing on Windows-shaped
                // paths). Run via `npm test` on a Windows host. Self-gates
                // when invoked directly on POSIX (e.g. Linux CI).
                test: {
                    name: 'windows',
                    include: ['test/windows/**/*.test.ts'],
                    ...shared,
                },
            },
            {
                // macOS-only assertions (APFS case-insensitivity with
                // production-default path comparison). Run via `npm test` on
                // a Mac. Self-gates when invoked directly off-macOS (e.g. Linux CI).
                test: {
                    name: 'macos',
                    include: ['test/macos/**/*.test.ts'],
                    ...shared,
                },
            },
        ],
    },
});
