import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    initialize_repository_with_initial_commit,
} from '../../helpers/git_repository.js';
import {
    branch_exists,
    create_patchlab_branch,
    patchlab_branch_name,
} from '../../../src/branch/index.js';

const { state, REAL_HOMEDIR, REAL_TMPDIR } = vi.hoisted(() => {
    const os = require('node:os');
    const home = os.homedir() as string;
    const tmp = os.tmpdir() as string;
    return {
        state: { homedir: home },
        REAL_HOMEDIR: home,
        REAL_TMPDIR: tmp,
    };
});

vi.mock('node:os', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:os')>();
    return {
        ...original,
        homedir: () => state.homedir,
    };
});

vi.mock('../../../src/container_runtime.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../src/container_runtime.js')>();
    return {
        ...original,
        create_container: vi.fn(),
        start_container: vi.fn(),
        stop_container: vi.fn(),
        remove_container: vi.fn(),
        exec_container: vi.fn(() => ''),
        copy_to_container: vi.fn(),
        container_exists: vi.fn(() => false),
        container_running: vi.fn(() => false),
        install_package: vi.fn(),
        get_image_tool_state: vi.fn(() => 'absent'),
        image_exists: vi.fn(() => false),
        commit_container: vi.fn(),
        get_image_home: (user: string) => `/home/${user}`,
        get_working_directory: (user: string) => `/home/${user}/workspace`,
    };
});

import { destroy_sandbox } from '../../../src/sandbox/index.js';

describe('destroy_sandbox with unreadable manifest (R14)', () => {
    let test_root: string;
    let repository: string;
    const sandbox_id = 'corrupt-destroy-id';

    beforeEach(() => {
        test_root = fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-destroy-corrupt-'));
        state.homedir = test_root;
        repository = fs.realpathSync(fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-destroy-corrupt-repo-')));
        initialize_repository_with_initial_commit(repository);
        create_patchlab_branch(repository, sandbox_id);
    });

    afterEach(() => {
        state.homedir = REAL_HOMEDIR;
        fs.rmSync(test_root, { recursive: true, force: true });
        fs.rmSync(repository, { recursive: true, force: true });
    });

    function write_corrupt_archive(manifest_body: string): string {
        const sandbox_dir = path.join(test_root, '.patchlab', sandbox_id);
        fs.mkdirSync(sandbox_dir, { recursive: true });
        fs.writeFileSync(path.join(sandbox_dir, 'manifest.json'), manifest_body, 'utf-8');
        return sandbox_dir;
    }

    it('retains archive and branch when manifest.json is not valid JSON', async () => {
        const sandbox_dir = write_corrupt_archive('{not valid json');

        const result = await destroy_sandbox(sandbox_id);

        expect(result.archive_removed).toBe(false);
        expect(result.manifest_unreadable).toBe(true);
        expect(fs.existsSync(sandbox_dir)).toBe(true);
        expect(branch_exists(repository, patchlab_branch_name(sandbox_id))).toBe(true);
    });

    it('retains archive and branch on default destroy when manifest fails schema validation', async () => {
        const sandbox_dir = write_corrupt_archive(JSON.stringify({
            format_version: 999,
            sources: [{
                host_path: path.join(repository, 'src'),
                repository_root: repository,
                source_prefix: 'src',
                mount_name: 'src',
            }],
            id: sandbox_id,
            created_at: '2026-04-25T00:00:00.000Z',
            container_name: `patchlab-${sandbox_id}`,
            container_image: 'node:22-slim',
        }, null, 2));

        const result = await destroy_sandbox(sandbox_id);

        expect(result.archive_removed).toBe(false);
        expect(result.manifest_unreadable).toBe(true);
        expect(fs.existsSync(sandbox_dir)).toBe(true);
        expect(branch_exists(repository, patchlab_branch_name(sandbox_id))).toBe(true);
    });

    it('with --force, deletes branch from leniently parsed repository roots and removes archive', async () => {
        write_corrupt_archive(JSON.stringify({
            format_version: 999,
            sources: [{
                host_path: path.join(repository, 'src'),
                repository_root: repository,
                source_prefix: 'src',
                mount_name: 'src',
            }],
            id: sandbox_id,
            created_at: '2026-04-25T00:00:00.000Z',
            container_name: `patchlab-${sandbox_id}`,
            container_image: 'node:22-slim',
        }, null, 2));
        const sandbox_dir = path.join(test_root, '.patchlab', sandbox_id);

        const result = await destroy_sandbox(sandbox_id, { force: true });

        expect(result.manifest_unreadable).toBe(true);
        expect(result.branch_outcomes[repository]).toBe('deleted');
        expect(result.archive_removed).toBe(true);
        expect(fs.existsSync(sandbox_dir)).toBe(false);
        expect(branch_exists(repository, patchlab_branch_name(sandbox_id))).toBe(false);
    });

    it('with --force but no discoverable repository roots, retains archive and branch', async () => {
        const sandbox_dir = write_corrupt_archive('{still not json');

        const result = await destroy_sandbox(sandbox_id, { force: true });

        expect(result.archive_removed).toBe(false);
        expect(result.manifest_unreadable).toBe(true);
        expect(fs.existsSync(sandbox_dir)).toBe(true);
        expect(branch_exists(repository, patchlab_branch_name(sandbox_id))).toBe(true);
    });
});
