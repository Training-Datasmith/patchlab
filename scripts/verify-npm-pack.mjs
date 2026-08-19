#!/usr/bin/env node
// Verify the published npm artifact from a clean tree: no pre-existing dist/,
// prepack builds on pack, tarball includes dist/, and the CLI runs after install.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIRECTORY = path.join(REPOSITORY_ROOT, 'dist');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    });

    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `\n${detail}` : ''}`);
    }

    return result;
}

function remove_directory(directory) {
    if (fs.existsSync(directory)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function main() {
    const had_dist = fs.existsSync(DIST_DIRECTORY);
    remove_directory(DIST_DIRECTORY);

    try {
        const dry_run = run('npm', ['pack', '--dry-run']);
        const listing = `${dry_run.stdout}${dry_run.stderr}`;

        if (!listing.includes('dist/cli.js')) {
            throw new Error('npm pack --dry-run did not include dist/cli.js');
        }

        if (listing.includes('src/')) {
            throw new Error('npm pack --dry-run included src/ — files allowlist is too broad');
        }

        const pack = run('npm', ['pack', '--silent']);
        const tarball_name = pack.stdout.trim().split('\n').pop();
        if (!tarball_name?.endsWith('.tgz')) {
            throw new Error(`unexpected npm pack output: ${pack.stdout}`);
        }

        const tarball_path = path.join(REPOSITORY_ROOT, tarball_name);
        const install_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-pack-verify-'));
        const foreign_cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-pack-cwd-'));

        try {
            run('npm', ['install', '--prefix', install_root, tarball_path]);

            const patchlab_bin = path.join(
                install_root,
                'node_modules',
                '.bin',
                process.platform === 'win32' ? 'patchlab.cmd' : 'patchlab',
            );

            const version = run(patchlab_bin, ['--version'], { cwd: foreign_cwd });
            const version_text = version.stdout.trim();
            if (!/^\d+\.\d+\.\d+/.test(version_text)) {
                throw new Error(`patchlab --version returned unexpected output: ${version_text}`);
            }

            console.log(`verify:pack ok (${version_text})`);
        } finally {
            fs.rmSync(install_root, { recursive: true, force: true });
            fs.rmSync(foreign_cwd, { recursive: true, force: true });
            fs.rmSync(tarball_path, { force: true });
        }
    } finally {
        if (!had_dist) {
            remove_directory(DIST_DIRECTORY);
        }
    }
}

main();
