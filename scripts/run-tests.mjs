#!/usr/bin/env node
// Cross-platform `npm test` dispatcher.
//
// Linux: native vitest covers unit, integration (when a runtime is available),
// posix, and platform-gated windows/macos projects (self-skip on Linux).
//
// macOS / Windows: posix runs in a Linux container via `scripts/test-posix.mjs`.
// Native tiers run unit, integration (runtime-gated), and the host platform
// project (`macos` on macOS, `windows` on Windows). Cross-platform projects
// are omitted (no Windows tests on macOS, no macOS tests on Windows).
//
// Integration is split by container runtime:
//   - `integration` — runtime-agnostic tests; runs when podman or nerdctl is available
//   - `integration-podman` — podman-only tests; runs when podman responds
//   - `integration-nerdctl` — nerdctl-only tests; runs when nerdctl responds (macOS)

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    is_nerdctl_available,
    is_podman_available,
    pick_integration_runtime,
} from './container-runtime-probe.mjs';

const windows = process.platform === 'win32';
const macos = process.platform === 'darwin';
const needs_posix_container = windows || macos;

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function integration_runtime_tests_exist(subdirectory) {
    const directory = path.join(REPOSITORY_ROOT, 'test', 'integration', subdirectory);
    if (!fs.existsSync(directory)) {
        return false;
    }

    const stack = [directory];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entry_path = path.join(current, entry.name);
            if (entry.isFile() && entry.name.endsWith('.test.ts')) {
                return true;
            }
            if (entry.isDirectory()) {
                stack.push(entry_path);
            }
        }
    }

    return false;
}

function run(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            ...options,
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, ...options.env },
        });
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
    });
}

async function run_vitest(projects, env = {}) {
    const args = ['vitest', 'run'];
    for (const project of projects) {
        args.push('--project', project);
    }

    return run('npx', args, { shell: windows, env });
}

async function run_native_tiers() {
    const projects = ['unit'];
    if (windows) {
        projects.push('windows');
    } else if (macos) {
        projects.push('macos');
    } else {
        projects.push('posix', 'windows', 'macos');
    }

    return run_vitest(projects);
}

function merge_exit_code(accumulated, code) {
    return accumulated !== 0 ? accumulated : (code ?? 1);
}

async function run_integration_tiers() {
    let status = 0;
    const primary_runtime = pick_integration_runtime();

    if (primary_runtime !== null) {
        status = merge_exit_code(status, await run_vitest(['integration'], {
            PATCHLAB_CONTAINER_RUNTIME: primary_runtime,
        }));
    }

    if (is_podman_available() && integration_runtime_tests_exist('podman')) {
        status = merge_exit_code(status, await run_vitest(['integration-podman'], {
            PATCHLAB_CONTAINER_RUNTIME: 'podman',
        }));
    }

    if (is_nerdctl_available() && integration_runtime_tests_exist('nerdctl')) {
        status = merge_exit_code(status, await run_vitest(['integration-nerdctl'], {
            PATCHLAB_CONTAINER_RUNTIME: 'nerdctl',
        }));
    }

    return status;
}

let exit_code = await run_native_tiers();
exit_code = merge_exit_code(exit_code, await run_integration_tiers());

if (needs_posix_container) {
    exit_code = merge_exit_code(exit_code, await run('node', ['scripts/test-posix.mjs']));
}

process.exit(exit_code);
