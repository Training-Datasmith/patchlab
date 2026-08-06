/**
 * Locks the CLI handler contract that `--tool` is required on create and
 * build-image, and that resume reads the tool from the sandbox manifest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';
import { initialize_repository_with_initial_commit } from '../../helpers/git_repository.js';

const {
    mock_create_sandbox,
    mock_resume_sandbox,
    mock_build_image,
    mock_ensure_default_image,
    mock_exec_interactive,
} = vi.hoisted(() => ({
    mock_create_sandbox: vi.fn(),
    mock_resume_sandbox: vi.fn(),
    mock_build_image: vi.fn(async () => 'patchlab/mock-test-image:latest'),
    mock_ensure_default_image: vi.fn(async (_project_directory: string, _tool: string) => 'patchlab/mock-test-image:latest'),
    mock_exec_interactive: vi.fn(),
}));

vi.mock('../../../src/sandbox/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/sandbox/index.js')>();
    return {
        ...actual,
        create_sandbox: (...arguments_list: Parameters<typeof actual.create_sandbox>) =>
            mock_create_sandbox(...arguments_list),
        resume_sandbox: (...arguments_list: Parameters<typeof actual.resume_sandbox>) =>
            mock_resume_sandbox(...arguments_list),
    };
});

vi.mock('../../../src/images.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/images.js')>();
    return {
        ...actual,
        build_image: mock_build_image,
    };
});

vi.mock('../../../src/auto_build.js', () => ({
    ensure_default_image: mock_ensure_default_image,
}));

vi.mock('../../../src/tools/configured_provider/trust_verification.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/tools/configured_provider/trust_verification.js')>();
    return {
        ...actual,
        verify_per_source_trust_multi_repository: vi.fn(),
    };
});

vi.mock('../../../src/podman.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/podman.js')>();
    return {
        ...actual,
        exec_interactive: (...arguments_list: Parameters<typeof actual.exec_interactive>) =>
            mock_exec_interactive(...arguments_list),
    };
});

import {
    handle_create_command,
    handle_resume_command,
    handle_build_image_command,
} from '../../../src/cli.js';
import * as tools_index from '../../../src/tools/index.js';
import type { Sandbox_Manifest } from '../../../src/manifest.js';
import { build_archive_path } from '../../../src/archive.js';
import { create_manifest, write_manifest } from '../../../src/manifest.js';
import { create_patchlab_branch } from '../../../src/branch/index.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../../helpers/stub_tool_provider.js';

describe('CLI handlers require --tool on create and build-image', () => {
    install_isolated_home_hooks('patchlab-cli-default-tool-');
    let repository: string;
    const patchlab_id = '00000000-0000-4000-8000-000000000003';

    beforeEach(() => {
        mock_create_sandbox.mockReset();
        mock_resume_sandbox.mockReset();
        mock_build_image.mockReset();
        mock_ensure_default_image.mockReset();
        mock_ensure_default_image.mockResolvedValue('patchlab/mock-test-image:latest');
        mock_create_sandbox.mockResolvedValue({
            id: 'new-sandbox-id',
            container_name: 'patchlab-new',
        });
        mock_exec_interactive.mockReset();
        register_default_test_tool();

        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-default-tool-')));
        initialize_repository_with_initial_commit(repository);
        create_patchlab_branch(repository, patchlab_id);

        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-resume-test',
            'patchlab/test:latest',
        );
        manifest.tool = DEFAULT_TEST_TOOL;
        write_manifest(archive_directory, manifest);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('handle_create_command exits when --tool is omitted', async () => {
        const exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as typeof process.exit);

        await expect(handle_create_command(repository, { interactive: false }))
            .rejects.toThrow('process.exit');

        expect(mock_create_sandbox).not.toHaveBeenCalled();
        exit_spy.mockRestore();
    });

    it('handle_create_command passes the requested tool to create_sandbox', async () => {
        await handle_create_command(repository, { interactive: false, tool: DEFAULT_TEST_TOOL });

        expect(mock_create_sandbox).toHaveBeenCalledTimes(1);
        expect(mock_create_sandbox.mock.calls[0][1]).toEqual(
            expect.objectContaining({ tool: DEFAULT_TEST_TOOL }),
        );
    });

    it('handle_resume_command resolves the manifest tool for interactive exec', async () => {
        const resumed_manifest: Sandbox_Manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-resume-test',
            'patchlab/test:latest',
        );
        resumed_manifest.tool = DEFAULT_TEST_TOOL;
        mock_resume_sandbox.mockResolvedValue(resumed_manifest);

        const provider_spy = vi.spyOn(tools_index, 'get_provider');
        await handle_resume_command(patchlab_id, {});

        expect(mock_resume_sandbox).toHaveBeenCalledTimes(1);
        expect(provider_spy).toHaveBeenCalledWith(DEFAULT_TEST_TOOL);
        expect(mock_exec_interactive).toHaveBeenCalled();
    });

    it('handle_build_image_command exits when --tools is omitted', async () => {
        const exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as typeof process.exit);

        await expect(handle_build_image_command({ base: 'node:22-slim' }))
            .rejects.toThrow('process.exit');

        expect(mock_build_image).not.toHaveBeenCalled();
        exit_spy.mockRestore();
    });
});
