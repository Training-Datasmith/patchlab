#!/usr/bin/env node
// Assert that patchlab resolves the expected container runtime before CI tests run.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const required = process.argv[2]?.toLowerCase();
if (required !== 'podman' && required !== 'nerdctl') {
    console.error('usage: assert-container-runtime.mjs <podman|nerdctl>');
    process.exit(1);
}

const repository_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync('npm', ['run', 'build'], {
    cwd: repository_root,
    stdio: 'pipe',
    encoding: 'utf8',
});
if (build.status !== 0) {
    process.stderr.write(build.stderr ?? build.stdout ?? 'build failed\n');
    process.exit(build.status ?? 1);
}

process.env.PATCHLAB_CONTAINER_RUNTIME = required;

const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `
import { assert_required_container_runtime } from './dist/container_runtime/required_runtime.js';
import { get_container_runtime, _reset_container_runtime } from './dist/container_runtime/index.js';
process.env.PATCHLAB_REQUIRED_CONTAINER_RUNTIME = ${JSON.stringify(required)};
_reset_container_runtime();
assert_required_container_runtime();
const { kind, binary } = get_container_runtime();
console.log(JSON.stringify({ kind, binary }));
`],
    {
        cwd: repository_root,
        stdio: 'pipe',
        encoding: 'utf8',
        env: {
            ...process.env,
            PATCHLAB_CONTAINER_RUNTIME: required,
            PATCHLAB_REQUIRED_CONTAINER_RUNTIME: required,
        },
    },
);

if (probe.status !== 0) {
    process.stderr.write(probe.stderr || probe.stdout || 'runtime probe failed\n');
    process.exit(probe.status ?? 1);
}

let resolved;
try {
    resolved = JSON.parse(probe.stdout.trim().split('\n').pop() ?? '{}');
} catch {
    console.error(`unexpected probe output: ${probe.stdout}`);
    process.exit(1);
}

if (resolved.kind !== required) {
    console.error(`Expected runtime ${required}, resolved ${resolved.kind} (${resolved.binary})`);
    process.exit(1);
}

console.log(`assert-container-runtime ok (${required} via ${resolved.binary})`);
