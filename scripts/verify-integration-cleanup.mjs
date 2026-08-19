#!/usr/bin/env node
// Fail CI when integration tests leave patchlab containers or archives behind.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function runtime_binary() {
    if (process.env.PATCHLAB_CONTAINER_RUNTIME === 'nerdctl') {
        return process.platform === 'darwin' ? 'nerdctl.lima' : 'nerdctl';
    }
    return 'podman';
}

function list_patchlab_containers() {
    const result = spawnSync(
        runtime_binary(),
        ['ps', '-a', '--filter', 'name=patchlab-', '--format', '{{.Names}}'],
        { encoding: 'utf8' },
    );
    if (result.status !== 0) {
        throw new Error(
            `Could not list containers via ${runtime_binary()}: `
            + `${[result.stdout, result.stderr].filter(Boolean).join('\n').trim()}`,
        );
    }
    return result.stdout.trim().split('\n').filter(Boolean);
}

function count_patchlab_archives(home_directory) {
    const archive_root = path.join(home_directory, '.patchlab');
    if (!fs.existsSync(archive_root)) {
        return 0;
    }

    return fs.readdirSync(archive_root).filter((entry) => {
        try {
            return fs.statSync(path.join(archive_root, entry)).isDirectory();
        } catch {
            return false;
        }
    }).length;
}

function main() {
    const containers = list_patchlab_containers();
    const home_directory = process.env.PATCHLAB_HOME || os.homedir();
    const archives = count_patchlab_archives(home_directory);

    let failed = false;
    if (containers.length > 0) {
        console.error(`Leaked patchlab containers (${containers.length}):`);
        for (const name of containers) {
            console.error(`  ${name}`);
        }
        failed = true;
    }

    if (archives > 0) {
        console.error(
            `Leaked patchlab archives under ${home_directory}/.patchlab/ (${archives}). `
            + 'Integration tests should destroy every sandbox they create.',
        );
        failed = true;
    }

    if (failed) {
        process.exit(1);
    }

    console.log('verify:integration-cleanup ok');
}

main();
