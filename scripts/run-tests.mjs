#!/usr/bin/env node
// Cross-platform `npm test` dispatcher.
//
// Linux / macOS: `vitest run` covers every project (`unit`, `windows`,
// `integration`, `posix`) — the posix project's filesystem assertions
// (fifo/socket types, case-sensitive `.YAML` vs `.yaml`, unprivileged
// symlinks) hold natively on those hosts.
//
// Windows: NTFS cannot simulate those POSIX filesystem semantics, so the
// posix project is delegated to `scripts/test-posix.mjs`, which spins up
// a Linux container via Podman and runs the project inside. The other
// projects still run natively on the Windows host — the integration
// project drives Podman per-test rather than wrapping the whole suite.

import { spawn } from 'node:child_process';

const windows = process.platform === 'win32';

// Spawn a child process, piping stdout/stderr through process.stdout/stderr
// so that background task runners capture output rather than losing it when
// there is no inherited terminal fd.
function run(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] });
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
    });
}

const vitest_arguments = ['vitest', 'run'];
if (windows) {
    vitest_arguments.push('--project', 'unit', '--project', 'windows', '--project', 'integration');
}

// `shell: true` on Windows so `npx` resolves to `npx.cmd` via PATHEXT; on
// POSIX the same call is direct.
const native_status = await run('npx', vitest_arguments, { shell: windows });
if (native_status !== 0) {
    process.exit(native_status);
}

if (windows) {
    const posix_status = await run('node', ['scripts/test-posix.mjs']);
    process.exit(posix_status);
}
