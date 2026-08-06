#!/usr/bin/env node
// Run the `posix` vitest project inside a Linux container via podman.
//
// We use this rather than running the suite directly because three tests
// (fifo/socket type detection, case-sensitive `.YAML` extension, unprivileged
// symlinks) exercise filesystem behaviour that Windows hosts cannot simulate.
//
// The container gets the source tree as an overlay mount (`:O`), so the
// fresh `npm ci` inside doesn't replace the host's Windows-built esbuild
// binary. node_modules is cached in a podman named volume so the install
// only runs slowly on the first invocation.

import { spawnSync } from 'node:child_process';
import { sep } from 'node:path';

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
    // Skip install when the cached volume already has the lockfile-matching tree.
    'if [ ! -f /work/node_modules/.posix-installed ]; then',
    '  npm ci --prefer-offline --no-audit --no-fund &&',
    '  touch /work/node_modules/.posix-installed;',
    'fi &&',
    // Drop to the image's built-in non-root `node` user (uid 1000) for the
    // actual vitest run. CI's ubuntu-latest runner is also non-root, so the
    // posix project's chmod-gated tests (e.g., EACCES) behave the same in
    // both environments. Running as root would bypass file-mode permission
    // checks on Linux and break those assertions.
    'su node -c "npx vitest run --project posix"',
].join(' ');

const result = spawnSync(
    'podman',
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
    console.error(`Failed to invoke podman: ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
