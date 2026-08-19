/**
 * R16 — create --copy must apply the same secret-file confirmation and auth
 * tagging as resume --copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../../helpers/stub_tool_provider.js';

const {
    mock_detect_secret_copies,
    mock_set_up_image_tier,
    mock_confirm,
} = vi.hoisted(() => ({
    mock_detect_secret_copies: vi.fn(() => [] as string[]),
    mock_set_up_image_tier: vi.fn(() => 'node:22-slim-auth'),
    mock_confirm: vi.fn(async () => false),
}));

vi.mock('../../../src/sandbox/branch_handshake.js', () => ({
    collect_unique_repositories: vi.fn((sources: { repository_root: string }[]) =>
        Array.from(new Set(sources.map((source) => source.repository_root))),
    ),
    execute_phase_1_preflight: vi.fn(async () => new Set<string>()),
    execute_phase_2_mutations: vi.fn((_repositories, _id, _dirty, created_branches: string[]) => {
        created_branches.push(_repositories[0]);
        return {
            baseline_commit_shas: { [_repositories[0]]: null },
            branch_creation_point_shas: { [_repositories[0]]: null },
        };
    }),
    rollback_phase_2_created_branches: vi.fn(),
    validate_source_paths: vi.fn(),
}));

vi.mock('../../../src/sandbox/workspace_staging.js', () => ({
    check_gitignore_for_node_modules: vi.fn(),
    copy_additional_paths: vi.fn(),
    copy_multi_source_files: vi.fn(),
    detect_secret_copies: mock_detect_secret_copies,
    initialize_sandbox_git_baseline: vi.fn(),
    install_dependencies: vi.fn(),
    install_npm_packages: vi.fn(),
    overlay_into_container: vi.fn(),
    overlay_multi_source_host_files: vi.fn(),
    prepare_workspace: vi.fn(),
}));

vi.mock('../../../src/container_runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/container_runtime.js')>();
    return {
        ...actual,
        DEFAULT_IMAGE: 'node:22-slim',
        container_exists: vi.fn(() => false),
        container_name_for: vi.fn((id: string) => `c-${id}`),
        container_running: vi.fn(() => false),
        create_container: vi.fn(),
        query_running_containers: vi.fn(() => []),
        runtime_host_tmpdir: vi.fn(() => os.tmpdir()),
        start_container: vi.fn(),
        stop_and_remove_container_best_effort: vi.fn(),
        was_authentication_attempted_at_build: vi.fn(() => false),
    };
});

vi.mock('../../../src/sandbox/image_tier.js', () => ({
    resolve_effective_image: vi.fn(() => ({ effective_image: 'node:22-slim', tool_state: 'absent' })),
    set_up_image_tier: mock_set_up_image_tier,
}));

vi.mock('../../../src/resource_limits.js', () => ({
    UNLIMITED: -1,
    resolve_resource_limits: vi.fn(() => ({
        memory_limit: -1, cpu_limit: -1, pids_limit: -1, blkio_weight: null,
    })),
    resolved_limits_to_create_options: vi.fn(() => ({
        memory_limit: undefined, cpu_limit: undefined, pids_limit: undefined, blkio_weight: undefined,
    })),
}));

vi.mock('../../../src/sandbox/persisted_resource_limits.js', () => ({
    EMPTY_LOADED_CONFIGURATION: { user_global_resource_limits: null, per_source_resource_limits: {} },
    read_persisted_resource_limits: vi.fn(() => null),
}));

vi.mock('../../../src/sandbox/session_archive.js', () => ({
    check_required_for_resume: vi.fn(),
    write_initial_session_metadata: vi.fn(() => 1),
}));

vi.mock('../../../src/sandbox/context_injection.js', () => ({
    inject_context_bundle: vi.fn(),
    inject_resume_context: vi.fn(),
}));

vi.mock('../../../src/cgroups.js', () => ({
    warn_once_if_unsupported: vi.fn(),
}));

vi.mock('../../../src/tools/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/tools/index.js')>();
    return {
        ...actual,
        compute_container_workspace_path: vi.fn(() => '/home/patchlab/workspace'),
        get_provider: vi.fn(() => ({
            name: DEFAULT_TEST_TOOL,
            display_name: 'Test tool',
            image_specification: {
                base_image: 'node:22-slim',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: '.stub',
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() { return { lines: [] }; },
            },
            inject_authentication: vi.fn(() => ({ type: 'none' as const })),
            get_launch_command() { return ['stub']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return DEFAULT_TEST_TOOL; },
            get_authentication_method: () => 'none' as const,
            get_extractable_artifacts() { return []; },
            inject_session_state: vi.fn(),
        })),
        register_per_source_manifests: vi.fn(() => ({
            manifest_buffers: new Map(),
            registered_manifests: [],
            registered_manifest_repositories: [],
            errors: [],
        })),
    };
});

vi.mock('../../../src/sandbox/host_access.js', () => ({
    prepare_provider_host_access: vi.fn(async () => ({
        extra_hosts: [],
        extra_environment_variables: {},
        file_copies: [],
        stop: async () => {},
    })),
    inject_provider_host_files: vi.fn(),
    stop_prepared_host_access: vi.fn(async () => {}),
}));

vi.mock('../../../src/tools/configured_provider/trust_verification.js', () => ({
    verify_per_source_trust_multi_repository: vi.fn(),
}));

vi.mock('../../../src/sandbox/workspace_copies.js', () => ({
    copy_workspace_copies_to_archive: vi.fn(),
    merge_resume_workspace_copies: vi.fn(() => ({ warnings: [] })),
    restore_workspace_copies: vi.fn(),
}));

import { create_sandbox } from '../../../src/sandbox/index.js';
import { create_container } from '../../../src/container_runtime.js';
import { set_up_image_tier } from '../../../src/sandbox/image_tier.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

describe('create_sandbox secret --copy gate (R16)', () => {
    install_isolated_home_hooks('patchlab-create-secret-copy-');

    let source_directory: string;
    let secret_source: string;

    beforeEach(() => {
        register_default_test_tool();
        mock_detect_secret_copies.mockReset();
        mock_detect_secret_copies.mockReturnValue([]);
        mock_set_up_image_tier.mockReset();
        mock_set_up_image_tier.mockReturnValue('node:22-slim-auth');
        mock_confirm.mockReset();
        mock_confirm.mockResolvedValue(false);
        vi.mocked(create_container).mockReset();

        source_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-create-secret-src-')),
        );
        secret_source = path.join(source_directory, '.env');
        fs.writeFileSync(secret_source, 'API_KEY=secret\n');
    });

    it('rejects secret --copy without confirmation in non-interactive create', async () => {
        mock_detect_secret_copies.mockReturnValue([secret_source]);

        await expect(create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            {
                tool: DEFAULT_TEST_TOOL,
                copy_paths: [{ source_path: secret_source, destination: '.env' }],
                prompter: null,
            },
        )).rejects.toThrow('Secret-file --copy not confirmed; create aborted.');

        expect(create_container).not.toHaveBeenCalled();
    });

    it('prompts before proceeding when secret --copy is confirmed', async () => {
        mock_detect_secret_copies.mockReturnValue([secret_source]);
        mock_confirm.mockResolvedValue(true);

        await create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            {
                tool: DEFAULT_TEST_TOOL,
                copy_paths: [{ source_path: secret_source, destination: '.env' }],
                prompter: { confirm: mock_confirm, choose: vi.fn() },
            },
        );

        expect(mock_confirm).toHaveBeenCalledOnce();
        const confirm_message = vi.mocked(mock_confirm).mock.calls.at(0)?.at(0);
        expect(confirm_message).toContain('.env');
        expect(create_container).toHaveBeenCalled();
    });

    it('tags the image as auth when secret --copy is confirmed on a none-auth provider', async () => {
        mock_detect_secret_copies.mockReturnValue([secret_source]);
        mock_confirm.mockResolvedValue(true);

        const manifest = await create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            {
                tool: DEFAULT_TEST_TOOL,
                copy_paths: [{ source_path: secret_source, destination: '.env' }],
                prompter: { confirm: mock_confirm, choose: vi.fn() },
            },
        );

        expect(set_up_image_tier).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.objectContaining({ effective_image: 'node:22-slim' }),
            DEFAULT_TEST_TOOL,
            { type: 'file_copy' },
            expect.any(Object),
            expect.any(Object),
        );
        expect(manifest.effective_image).toBe('node:22-slim-auth');
    });
});
