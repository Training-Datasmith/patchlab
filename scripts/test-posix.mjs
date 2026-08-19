#!/usr/bin/env node
// Run the `posix` vitest project inside a Linux container via the active
// container runtime (podman on Linux/Windows, nerdctl.lima on macOS).
//
// We use this rather than running the suite directly because three tests
// (fifo/socket type detection, case-sensitive `.YAML` extension, unprivileged
// symlinks) exercise filesystem behaviour that Windows and macOS hosts cannot
// simulate (NTFS / default APFS are case-insensitive).
//
// The container gets the source tree as an overlay mount (`:O`), so the
// fresh `npm ci` inside doesn't replace the host's Windows-built esbuild
// binary. node_modules is cached in a podman named volume so the install
// only runs slowly on the first invocation.

import { spawnSync } from 'node:child_process';
import { sep } from 'node:path';

function resolve_posix_runtime() {
    if (process.env.PATCHLAB_CONTAINER_RUNTIME === 'podman') {
        return 'podman';
    }

    for (const candidate of ['nerdctl.lima', 'nerdctl', 'podman']) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'pipe' });
        if (probe.status === 0) {
            return candidate;
        }
    }

    return 'podman';
}

const CONTAINER_RUNTIME = resolve_posix_runtime();

const NODE_IMAGE = 'node:24-alpine';
const NODE_MODULES_VOLUME = 'patchlab-posix-node-modules';
const SOURCE_MOUNT = process.cwd().replaceAll(sep, '/');

const inner_command = [
    // `test/posix/branch.test.ts` shells out to `git` to set up its fixtures
    // (init, commit, baseline). The base image (`node:24-alpine`) does not
    // ship with git, so install it on every run. Cheap — ~3 seconds against
    // a 5-second total — and avoids the build/maintenance cost of a custom
    // pre-baked image. Container is `--rm`'d after each run, so the install
    // is per-run, not persisted.
    'apk add --no-cache git &&',
    // Re-install when the cached volume is missing vitest (stale/partial cache).
    'if [ ! -f /work/node_modules/vitest/vitest.mjs ]; then',
    '  npm ci --prefer-offline --no-audit --no-fund;',
    'fi &&',
    'chown -R node:node /work/node_modules &&',
    // Drop to the image's built-in non-root `node` user (uid 1000) for the
    // actual vitest run. CI's ubuntu-latest runner is also non-root, so the
    // posix project's chmod-gated tests (e.g., EACCES) behave the same in
    // both environments. Running as root would bypass file-mode permission
    // checks on Linux and break those assertions.
    'su node -c "node /work/node_modules/vitest/vitest.mjs run --project posix"',
].join(' ');

const result = spawnSync(
    CONTAINER_RUNTIME,
    [
        'run', '--rm',
        '-v', `${SOURCE_MOUNT}:/work:O`,
        '-v', `${NODE_MODULES_VOLUME}:/work/node_modules`,
        '-w', '/work',
        NODE_IMAGE,
        'sh', '-c', inner_command,
    ],
    { stdio: 'inherit' }
);

if (result.error) {
    console.error(`Failed to invoke ${CONTAINER_RUNTIME}: ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
