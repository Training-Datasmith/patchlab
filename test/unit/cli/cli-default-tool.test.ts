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
    mock_extract_workspace_copies,
} = vi.hoisted(() => ({
    mock_create_sandbox: vi.fn(),
    mock_resume_sandbox: vi.fn(),
    mock_build_image: vi.fn(async () => 'patchlab/mock-test-image:latest'),
    mock_ensure_default_image: vi.fn(async (_project_directory: string, _tool: string) => 'patchlab/mock-test-image:latest'),
    mock_exec_interactive: vi.fn(),
    mock_extract_workspace_copies: vi.fn(),
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

const { mock_verify_per_source_default_tool } = vi.hoisted(() => ({
    mock_verify_per_source_default_tool: vi.fn(async (..._arguments_list: unknown[]) => ({ override: null })),
}));

vi.mock('../../../src/tools/default_tool_trust.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/tools/default_tool_trust.js')>();
    return {
        ...actual,
        verify_per_source_default_tool: (...arguments_list: Parameters<typeof actual.verify_per_source_default_tool>) =>
            mock_verify_per_source_default_tool(...arguments_list),
    };
});

vi.mock('../../../src/container_runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/container_runtime.js')>();
    return {
        ...actual,
        exec_interactive: (...arguments_list: Parameters<typeof actual.exec_interactive>) =>
            mock_exec_interactive(...arguments_list),
    };
});

vi.mock('../../../src/sandbox/workspace_copies.js', () => ({
    extract_workspace_copies: (...arguments_list: unknown[]) =>
        mock_extract_workspace_copies(...arguments_list),
}));

import {
    handle_create_command,
    handle_resume_command,
    handle_build_image_command,
} from '../../../src/cli.js';
import * as tools_index from '../../../src/tools/index.js';
import type { Sandbox_Manifest } from '../../../src/manifest.js';
import { build_archive_path, write_session_metadata } from '../../../src/archive.js';
import { create_manifest, write_manifest } from '../../../src/manifest.js';
import { create_patchlab_branch } from '../../../src/branch/index.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../../helpers/stub_tool_provider.js';
import { DEFAULT_BUILTIN_TOOL, OPENCODE_TOOL_NAME } from '../../../src/tools/index.js';

describe('CLI handlers default --tool on create', () => {
    install_isolated_home_hooks('patchlab-cli-default-tool-');
    let repository: string;
    const patchlab_id = '00000000-0000-4000-8000-000000000003';

    beforeEach(() => {
        mock_create_sandbox.mockReset();
        mock_resume_sandbox.mockReset();
        mock_build_image.mockReset();
        mock_ensure_default_image.mockReset();
        mock_verify_per_source_default_tool.mockReset();
        mock_verify_per_source_default_tool.mockResolvedValue({ override: null });
        mock_ensure_default_image.mockResolvedValue('patchlab/mock-test-image:latest');
        mock_create_sandbox.mockResolvedValue({
            id: 'new-sandbox-id',
            container_name: 'patchlab-new',
        });
        mock_exec_interactive.mockReset();
        mock_extract_workspace_copies.mockReset();
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

    it('handle_create_command uses OpenCode when --tool is omitted', async () => {
        await handle_create_command(repository, { interactive: false });

        expect(mock_verify_per_source_default_tool).toHaveBeenCalledTimes(1);
        expect(mock_create_sandbox).toHaveBeenCalledTimes(1);
        expect(mock_create_sandbox.mock.calls[0][1]).toEqual(
            expect.objectContaining({ tool: DEFAULT_BUILTIN_TOOL }),
        );
    });

    it('handle_create_command skips default_tool verify when --tool is provided', async () => {
        await handle_create_command(repository, { interactive: false, tool: DEFAULT_TEST_TOOL });

        expect(mock_verify_per_source_default_tool).not.toHaveBeenCalled();
        expect(mock_create_sandbox).toHaveBeenCalledTimes(1);
        expect(mock_create_sandbox.mock.calls[0][1]).toEqual(
            expect.objectContaining({ tool: DEFAULT_TEST_TOOL }),
        );
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

describe('CLI handlers --prompt', () => {
    install_isolated_home_hooks('patchlab-cli-prompt-');
    let repository: string;
    const patchlab_id = '00000000-0000-4000-8000-000000000004';

    beforeEach(() => {
        mock_create_sandbox.mockReset();
        mock_resume_sandbox.mockReset();
        mock_ensure_default_image.mockReset();
        mock_verify_per_source_default_tool.mockReset();
        mock_verify_per_source_default_tool.mockResolvedValue({ override: null });
        mock_ensure_default_image.mockResolvedValue('patchlab/mock-test-image:latest');
        mock_exec_interactive.mockReset();
        mock_extract_workspace_copies.mockReset();
        register_default_test_tool();

        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-prompt-')));
        mock_create_sandbox.mockImplementation(async () => ({
            id: 'new-sandbox-id',
            container_name: 'patchlab-new',
            container_image: 'patchlab/test:latest',
            tool: OPENCODE_TOOL_NAME,
            sources: [{
                host_path: repository,
                repository_root: repository,
                source_prefix: '',
                mount_name: '',
            }],
        }));
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
        manifest.tool = OPENCODE_TOOL_NAME;
        write_manifest(archive_directory, manifest);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('handle_create_command rejects --prompt for unsupported tool before create_sandbox', async () => {
        const exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as typeof process.exit);

        await expect(handle_create_command(repository, {
            tool: DEFAULT_TEST_TOOL,
            prompt: 'hello',
        })).rejects.toThrow('process.exit');

        expect(mock_create_sandbox).not.toHaveBeenCalled();
        exit_spy.mockRestore();
    });

    it('handle_create_command runs opencode prompt argv', async () => {
        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            prompt: 'Add tests',
        });

        expect(mock_exec_interactive).toHaveBeenCalledWith(
            'patchlab-new',
            ['opencode', 'run', '--auto', '--', 'Add tests'],
            expect.any(String),
        );
    });

    it('handle_create_command runs opencode prompt argv with default tool', async () => {
        await handle_create_command(repository, {
            prompt: 'Add tests',
        });

        expect(mock_exec_interactive).toHaveBeenCalledWith(
            'patchlab-new',
            ['opencode', 'run', '--auto', '--', 'Add tests'],
            expect.any(String),
        );
    });

    it('handle_create_command propagates tool exit code after prompt launch', async () => {
        mock_exec_interactive.mockImplementation(() => {
            const error = new Error('exit 2') as Error & { status?: number };
            error.status = 2;
            throw error;
        });
        const previous_exit_code = process.exitCode;

        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            prompt: 'hi',
        });

        expect(process.exitCode).toBe(2);
        process.exitCode = previous_exit_code;
    });

    it('handle_create_command extracts session after failed prompt launch', async () => {
        const extract_patchlab_id = '00000000-0000-4000-8000-000000000005';
        const sandbox_manifest = create_manifest(
            extract_patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-extract-test',
            'patchlab/test:latest',
        );
        sandbox_manifest.tool = OPENCODE_TOOL_NAME;
        sandbox_manifest.container_name = 'patchlab-extract';

        const archive_directory = build_archive_path(extract_patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        write_manifest(archive_directory, sandbox_manifest);
        fs.mkdirSync(path.join(archive_directory, 'sessions', '1'), { recursive: true });
        write_session_metadata(extract_patchlab_id, 1, {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: OPENCODE_TOOL_NAME,
            container_name: sandbox_manifest.container_name,
            commit_shas: { [repository]: null },
            fallback_patches: { [repository]: null },
            resource_limits: null,
        });

        mock_create_sandbox.mockResolvedValue(sandbox_manifest);
        mock_exec_interactive.mockImplementation(() => {
            const error = new Error('exit 1') as Error & { status?: number };
            error.status = 1;
            throw error;
        });

        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            prompt: 'fail me',
        });

        expect(mock_extract_workspace_copies).toHaveBeenCalledWith(
            'patchlab-extract',
            expect.any(String),
            expect.stringContaining('workspace-copies'),
        );
    });

    it('handle_create_command leaves exit code unset when prompt launch succeeds', async () => {
        const previous_exit_code = process.exitCode;
        process.exitCode = undefined;

        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            prompt: 'hi',
        });

        expect(process.exitCode).toBeUndefined();
        process.exitCode = previous_exit_code;
    });

    it('handle_create_command skips exec when --no-interactive without -p', async () => {
        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            interactive: false,
        });

        expect(mock_exec_interactive).not.toHaveBeenCalled();
    });

    it('handle_create_command applies interactive passthrough argv', async () => {
        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            passthrough: ['--model', 'anthropic/claude-sonnet'],
        });

        expect(mock_exec_interactive).toHaveBeenCalledWith(
            'patchlab-new',
            ['opencode', '--model', 'anthropic/claude-sonnet'],
            expect.any(String),
        );
    });

    it('handle_create_command passes --prompt-file into context and opencode argv', async () => {
        const spec_path = path.join(repository, 'spec.md');
        fs.writeFileSync(spec_path, '# spec\n');

        await handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            prompt: 'Review spec',
            prompt_file: ['spec.md'],
        });

        expect(mock_create_sandbox).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                context_paths: expect.arrayContaining([spec_path]),
            }),
        );
        expect(mock_exec_interactive).toHaveBeenCalledWith(
            'patchlab-new',
            [
                'opencode', 'run', '--auto',
                '--file', '/home/patchlab/context/spec.md',
                '--', 'Review spec',
            ],
            expect.any(String),
        );
    });

    it('handle_create_command rejects passthrough on unsupported tool before create_sandbox', async () => {
        const exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as typeof process.exit);

        await expect(handle_create_command(repository, {
            tool: DEFAULT_TEST_TOOL,
            passthrough: ['--model'],
        })).rejects.toThrow('process.exit');

        expect(mock_create_sandbox).not.toHaveBeenCalled();
        exit_spy.mockRestore();
    });

    it('handle_create_command rejects passthrough with --no-interactive before create_sandbox', async () => {
        const exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as typeof process.exit);

        await expect(handle_create_command(repository, {
            tool: OPENCODE_TOOL_NAME,
            passthrough: ['--model'],
            interactive: false,
        })).rejects.toThrow('process.exit');

        expect(mock_create_sandbox).not.toHaveBeenCalled();
        exit_spy.mockRestore();
    });

    it('handle_resume_command rejects --prompt for unsupported tool in provider_preflight', async () => {
        const exit_spy = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as typeof process.exit);

        mock_resume_sandbox.mockImplementation(async (_patchlab_id, options) => {
            if (options?.provider_preflight) {
                options.provider_preflight(tools_index.get_provider(DEFAULT_TEST_TOOL));
            }
            return create_manifest(
                patchlab_id,
                [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
                'patchlab-resume-test',
                'patchlab/test:latest',
            );
        });

        await expect(handle_resume_command(patchlab_id, { prompt: 'hello' }))
            .rejects.toThrow('process.exit');

        expect(mock_exec_interactive).not.toHaveBeenCalled();
        exit_spy.mockRestore();
    });

    it('handle_resume_command propagates tool exit code after prompt launch', async () => {
        const resumed_manifest: Sandbox_Manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-resume-test',
            'patchlab/test:latest',
        );
        resumed_manifest.tool = OPENCODE_TOOL_NAME;
        resumed_manifest.container_name = 'patchlab-resumed';
        mock_resume_sandbox.mockImplementation(async (_patchlab_id, options) => {
            if (options?.provider_preflight) {
                options.provider_preflight(tools_index.get_provider(OPENCODE_TOOL_NAME));
            }
            return resumed_manifest;
        });
        mock_exec_interactive.mockImplementation(() => {
            const error = new Error('exit 2') as Error & { status?: number };
            error.status = 2;
            throw error;
        });
        const previous_exit_code = process.exitCode;

        await handle_resume_command(patchlab_id, { prompt: 'Fix bug' });

        expect(process.exitCode).toBe(2);
        process.exitCode = previous_exit_code;
    });

    it('handle_resume_command runs opencode resume prompt argv', async () => {
        const resumed_manifest: Sandbox_Manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-resume-test',
            'patchlab/test:latest',
        );
        resumed_manifest.tool = OPENCODE_TOOL_NAME;
        resumed_manifest.container_name = 'patchlab-resumed';
        mock_resume_sandbox.mockImplementation(async (_patchlab_id, options) => {
            if (options?.provider_preflight) {
                options.provider_preflight(tools_index.get_provider(OPENCODE_TOOL_NAME));
            }
            return resumed_manifest;
        });

        await handle_resume_command(patchlab_id, { prompt: 'Fix bug' });

        expect(mock_exec_interactive).toHaveBeenCalledWith(
            'patchlab-resumed',
            ['opencode', 'run', '--auto', '--continue', '--', 'Fix bug'],
            expect.any(String),
        );
    });

    it('handle_resume_command resolves a per-source-only tool before resume_sandbox', async () => {
        const tools_directory = path.join(repository, '.patchlab', 'tools');
        fs.mkdirSync(tools_directory, { recursive: true });
        fs.writeFileSync(path.join(tools_directory, 'foo.yaml'), [
            'name: foo',
            'display_name: Foo',
            'image_user: patchlab',
            'base_image: docker.io/library/debian:bookworm-slim',
            'base_family: debian',
            'package_manager: apt',
            'authentication:',
            '  method: none',
            'launch_command:',
            '  - foo',
            '',
        ].join('\n'));

        const archive_directory = build_archive_path(patchlab_id);
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-resume-test',
            'patchlab/test:latest',
        );
        manifest.tool = 'foo';
        write_manifest(archive_directory, manifest);

        const resumed_manifest: Sandbox_Manifest = { ...manifest, container_name: 'patchlab-resumed' };
        mock_resume_sandbox.mockResolvedValue(resumed_manifest);

        await expect(handle_resume_command(patchlab_id, { interactive: false }))
            .resolves.toBeUndefined();

        expect(mock_resume_sandbox).toHaveBeenCalledTimes(1);
    });
});
