// POSIX-only assertions for the create-path symlink-escape guard in
// `copy_multi_source_files`. Run via the `posix` vitest project (see
// vitest.config.ts) — typically inside a Linux container with
// `npm run test:posix`. These exercise unprivileged symlink creation, which
// Windows blocks, so the assertions would no-op there; here they run for real.
//
// The guard realpath-resolves each source file and refuses to copy anything
// whose real location escapes the source tree — covering both a leaf symlink
// and a file reached through a symlinked parent directory.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/container_runtime.js', () => ({
    CONTAINER_WORKING_DIR: '/home/patchlab/workspace',
    copy_to_container: vi.fn(),
    exec_container: vi.fn(),
    fix_workspace_ownership_if_needed: vi.fn(),
    runtime_host_tmpdir: vi.fn(() => os.tmpdir()),
}));

import { copy_multi_source_files } from '../../src/sandbox/workspace_staging.js';
import { copy_to_container, exec_container } from '../../src/container_runtime.js';
import type { Source_Specification } from '../../src/manifest.js';
import {
    install_recording_logger_hooks,
    filter_recorded_messages,
} from '../helpers/recording_logger.js';

const mocked_exec_container = vi.mocked(exec_container);
const mocked_copy_to_container = vi.mocked(copy_to_container);

function make_source(overrides: Partial<Source_Specification> = {}): Source_Specification {
    return {
        host_path: '/host/path',
        repository_root: '/host/path',
        source_prefix: '',
        mount_name: '',
        ...overrides,
    };
}

describe('copy_multi_source_files — symlink-escape guard (POSIX)', () => {
    const logger_handle = install_recording_logger_hooks();
    let source_directory: string;
    let outside_directory: string;

    // The staging directory is removed in copy_multi_source_files' `finally`
    // before the test regains control, so the only place to observe what was
    // actually staged is from inside the copy_to_container mock, which runs
    // while the directory still exists. Record its entries there (mutate the
    // same array in place across tests so the mock's closure stays valid).
    const staged_entries: string[] = [];

    beforeEach(() => {
        mocked_exec_container.mockReset();
        mocked_copy_to_container.mockReset();
        staged_entries.length = 0;
        mocked_copy_to_container.mockImplementation((_name, source_argument) => {
            const staging = String(source_argument).replace(/\/\.$/, '');
            if (fs.existsSync(staging)) {
                staged_entries.push(...fs.readdirSync(staging));
            }
        });
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-posix-src-')));
        outside_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-posix-outside-')));
    });

    afterEach(() => {
        fs.rmSync(source_directory, { recursive: true, force: true });
        fs.rmSync(outside_directory, { recursive: true, force: true });
    });

    function escape_warnings(): string[] {
        return filter_recorded_messages(logger_handle.current(), 'warn')
            .filter((message) => message.includes('escapes the source tree'));
    }

    function single_source(): Source_Specification[] {
        return [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];
    }

    it('skips a leaf symlink whose target escapes the source tree', () => {
        fs.writeFileSync(path.join(outside_directory, 'secret'), 'secret bytes');
        fs.symlinkSync(path.join(outside_directory, 'secret'), path.join(source_directory, 'escape'));
        // A regular in-tree file alongside it should still be copied.
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'export {};\n');

        copy_multi_source_files('container-x', single_source(), undefined, '/workspace');

        expect(escape_warnings()).toHaveLength(1);
        // The staged copy still ran for the legitimate file.
        expect(mocked_copy_to_container).toHaveBeenCalled();
        // app.ts was staged; the escaping symlink was not.
        expect(staged_entries).toContain('app.ts');
        expect(staged_entries).not.toContain('escape');
    });

    it('skips a file reached through a symlinked parent directory that escapes the tree', () => {
        // An explicit --include can name a path that traverses a symlinked dir.
        fs.writeFileSync(path.join(outside_directory, 'secret.txt'), 'secret bytes');
        fs.symlinkSync(outside_directory, path.join(source_directory, 'linkdir'));

        copy_multi_source_files(
            'container-x',
            single_source(),
            { include: ['linkdir/secret.txt'] },
            '/workspace',
        );

        // An explicit include names the file through the symlinked dir, so it
        // IS enumerated; the realpath guard then resolves it to the outside
        // tree and refuses it.
        expect(escape_warnings()).toHaveLength(1);
        // Nothing escaped into the staging directory through the symlink.
        expect(staged_entries).not.toContain('linkdir');
        expect(staged_entries).not.toContain('secret.txt');
    });
});
