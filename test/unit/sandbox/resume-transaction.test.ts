/**
 * R15 — resume must stay transactional: a failed replacement must leave the
 * prior container and on-disk manifest intact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../../helpers/stub_tool_provider.js';

const {
    mock_stop_and_remove,
    mock_stop_container,
    mock_start_container,
    mock_rename_container,
    mock_container_exists,
} = vi.hoisted(() => ({
    mock_stop_and_remove: vi.fn(),
    mock_stop_container: vi.fn(),
    mock_start_container: vi.fn(),
    mock_rename_container: vi.fn(),
    mock_container_exists: vi.fn(() => true),
}));

vi.mock('../../../src/sandbox/branch_handshake.js', () => ({
    collect_unique_repositories: vi.fn((sources: { repository_root: string }[]) =>
        Array.from(new Set(sources.map((source) => source.repository_root))),
    ),
    execute_phase_1_preflight: vi.fn(async () => new Set<string>()),
    execute_phase_2_mutations: vi.fn(),
    rollback_phase_2_created_branches: vi.fn(),
    validate_source_paths: vi.fn(),
}));

vi.mock('../../../src/branch/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/branch/index.js')>();
    return {
        ...actual,
        branch_exists: vi.fn(() => true),
        export_per_source_branch_tip_to_container: vi.fn(),
        is_git_repository: vi.fn(() => true),
        list_branch_files: vi.fn(() => []),
    };
});

vi.mock('../../../src/sandbox/workspace_staging.js', () => ({
    check_gitignore_for_node_modules: vi.fn(),
    copy_additional_paths: vi.fn(),
    copy_multi_source_files: vi.fn(),
    detect_secret_copies: vi.fn(() => []),
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
        container_exists: mock_container_exists,
        container_name_for: vi.fn((id: string) => `c-${id}`),
        container_running: vi.fn(() => false),
        create_container: vi.fn(),
        finalize_resumed_container: vi.fn(),
        query_running_containers: vi.fn(() => []),
        rename_container: (from_name: string, to_name: string) => mock_rename_container(from_name, to_name),
        resume_staging_container_name: vi.fn((id: string) => `c-${id}-resume-staging`),
        runtime_host_tmpdir: vi.fn(() => os.tmpdir()),
        start_container: (name: string) => mock_start_container(name),
        stop_container: (name: string) => mock_stop_container(name),
        stop_and_remove_container_best_effort: mock_stop_and_remove,
        was_authentication_attempted_at_build: vi.fn(() => false),
    };
});

vi.mock('../../../src/sandbox/image_tier.js', () => ({
    resolve_effective_image: vi.fn(() => ({ effective_image: 'node:22-slim', tool_state: 'absent' })),
    set_up_image_tier: vi.fn(() => 'node:22-slim'),
}));

vi.mock('../../../src/resource_limits.js', () => ({
    UNLIMITED: -1,
    resolve_resource_limits: vi.fn(() => ({
        memory_limit: -1, cpu_limit: -1, pids_limit: -1, blkio_weight: null,
    })),
    resolved_limits_to_persisted: vi.fn(() => null),
    resolved_limits_to_create_options: vi.fn(() => ({
        memory_limit: undefined, cpu_limit: undefined, pids_limit: undefined, blkio_weight: undefined,
    })),
}));

vi.mock('../../../src/sandbox/persisted_resource_limits.js', () => ({
    EMPTY_LOADED_CONFIGURATION: { user_global_resource_limits: null, per_source_resource_limits: {} },
    read_persisted_resource_limits: vi.fn(() => null),
}));

vi.mock('../../../src/sandbox/session_archive.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/sandbox/session_archive.js')>();
    return {
        ...actual,
        check_required_for_resume: vi.fn(),
        write_claimed_session_metadata: vi.fn(),
        write_initial_session_metadata: vi.fn(() => 2),
    };
});

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
            inject_authentication: vi.fn(() => ({ type: 'none' })),
            get_launch_command() { return ['stub']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return DEFAULT_TEST_TOOL; },
            get_authentication_method: () => 'none',
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
        stop: vi.fn(async () => {}),
    })),
    inject_provider_host_files: vi.fn(),
    stop_prepared_host_access: vi.fn(async () => {}),
}));

vi.mock('../../../src/tools/configured_provider/trust_verification.js', () => ({
    verify_per_source_trust_multi_repository: vi.fn(),
}));

vi.mock('../../../src/local_model_proxy/manager.js', () => ({
    stop_host_proxy: vi.fn(),
}));

vi.mock('../../../src/archive.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/archive.js')>();
    return { ...actual, latest_session_with_metadata: vi.fn(() => null) };
});

import { resume_sandbox } from '../../../src/sandbox/index.js';
import { build_archive_path, build_session_path } from '../../../src/archive.js';
import { create_manifest, read_manifest, write_manifest } from '../../../src/manifest.js';
import * as manifest_module from '../../../src/manifest.js';
import { create_patchlab_branch } from '../../../src/branch/index.js';
import {
    create_container,
    finalize_resumed_container,
    resume_staging_container_name,
} from '../../../src/container_runtime.js';
import { write_claimed_session_metadata } from '../../../src/sandbox/session_archive.js';
import { inject_resume_context } from '../../../src/sandbox/context_injection.js';
import { stop_prepared_host_access } from '../../../src/sandbox/host_access.js';
import { stop_host_proxy } from '../../../src/local_model_proxy/manager.js';
import { initialize_repository_with_initial_commit } from '../../helpers/git_repository.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

describe('resume_sandbox transaction (R15)', () => {
    install_isolated_home_hooks('patchlab-resume-transaction-');
    let repository: string;
    const patchlab_id = 'pl-resume-txn';

    beforeEach(() => {
        vi.restoreAllMocks();
        register_default_test_tool();
        mock_stop_and_remove.mockReset();
        mock_stop_container.mockReset();
        mock_start_container.mockReset();
        mock_rename_container.mockReset();
        mock_container_exists.mockReset();
        mock_container_exists.mockReturnValue(true);
        vi.mocked(finalize_resumed_container).mockReset();
        vi.mocked(create_container).mockReset();
        vi.mocked(resume_staging_container_name).mockClear();
        vi.mocked(stop_prepared_host_access).mockClear();
        vi.mocked(inject_resume_context).mockReset();
        vi.mocked(write_claimed_session_metadata).mockReset();

        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-resume-txn-repo-')));
        initialize_repository_with_initial_commit(repository);
        create_patchlab_branch(repository, patchlab_id);

        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: 'src' }],
            'c-pl-resume-txn',
            'patchlab/test:latest',
        );
        manifest.tool = DEFAULT_TEST_TOOL;
        write_manifest(archive_directory, manifest);
    });

    it('does not remove the previous container before provisioning succeeds', async () => {
        vi.mocked(create_container).mockImplementation(() => {
            throw new Error('create_container failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/create_container failed/);

        expect(mock_stop_and_remove).not.toHaveBeenCalledWith('c-pl-resume-txn');
        expect(mock_stop_and_remove).toHaveBeenCalledWith('c-pl-resume-txn-resume-staging');
        expect(stop_prepared_host_access).toHaveBeenCalledTimes(1);
        expect(stop_host_proxy).toHaveBeenCalledWith(patchlab_id);
    });

    it('stops the previous container before creating the staging container', async () => {
        vi.mocked(finalize_resumed_container).mockReturnValue(null);

        await resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        });

        expect(mock_stop_container).toHaveBeenCalledWith('c-pl-resume-txn');
        expect(mock_stop_container.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(create_container).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );
    });

    it('leaves the on-disk manifest unchanged when provisioning fails', async () => {
        const before = read_manifest(build_archive_path(patchlab_id));
        vi.mocked(create_container).mockImplementation(() => {
            throw new Error('create_container failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/create_container failed/);

        expect(read_manifest(build_archive_path(patchlab_id))).toEqual(before);
    });

    it('provisions in a staging container, then finalizes to the canonical name', async () => {
        vi.mocked(finalize_resumed_container).mockReturnValue(null);

        await resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        });

        expect(resume_staging_container_name).toHaveBeenCalledWith(patchlab_id);
        expect(vi.mocked(create_container).mock.calls[0]?.[0]).toBe('c-pl-resume-txn-resume-staging');
        expect(finalize_resumed_container).toHaveBeenCalledWith(
            'c-pl-resume-txn-resume-staging',
            'c-pl-resume-txn',
            'c-pl-resume-txn',
            patchlab_id,
        );
        expect(read_manifest(build_archive_path(patchlab_id)).container_name).toBe('c-pl-resume-txn');
        expect(vi.mocked(write_claimed_session_metadata).mock.calls.at(-1)?.[3]).toBe('c-pl-resume-txn');
    });

    it('restores the previous container when metadata persistence fails after finalize', async () => {
        vi.mocked(finalize_resumed_container).mockReturnValue('c-pl-resume-txn-previous-backup');
        vi.spyOn(manifest_module, 'write_manifest').mockImplementationOnce(() => {
            throw new Error('write_manifest failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/write_manifest failed/);

        expect(mock_stop_and_remove).toHaveBeenCalledWith('c-pl-resume-txn');
        expect(mock_rename_container).toHaveBeenCalledWith(
            'c-pl-resume-txn-previous-backup',
            'c-pl-resume-txn',
        );
        expect(read_manifest(build_archive_path(patchlab_id)).container_name).toBe('c-pl-resume-txn');
    });

    it('restores the on-disk manifest when session metadata write fails after finalize', async () => {
        const before = read_manifest(build_archive_path(patchlab_id));
        vi.mocked(finalize_resumed_container).mockReturnValue('c-pl-resume-txn-previous-backup');
        vi.mocked(write_claimed_session_metadata).mockImplementation(() => {
            throw new Error('write_claimed_session_metadata failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/write_claimed_session_metadata failed/);

        expect(read_manifest(build_archive_path(patchlab_id))).toEqual(before);
        expect(mock_rename_container).toHaveBeenCalledWith(
            'c-pl-resume-txn-previous-backup',
            'c-pl-resume-txn',
        );
    });

    it('discards a claimed session directory when provisioning fails after claim', async () => {
        fs.mkdirSync(path.join(build_archive_path(patchlab_id), 'sessions'), { recursive: true });
        fs.mkdirSync(build_session_path(patchlab_id, 1), { recursive: true });
        fs.writeFileSync(
            path.join(build_session_path(patchlab_id, 1), 'metadata.json'),
            JSON.stringify({ session_number: 1 }),
        );

        vi.mocked(inject_resume_context).mockImplementation(() => {
            throw new Error('inject_resume_context failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/inject_resume_context failed/);

        expect(fs.existsSync(build_session_path(patchlab_id, 2))).toBe(false);
    });

    it('restarts the previous container when provisioning fails after it was stopped', async () => {
        vi.mocked(create_container).mockImplementation(() => {
            throw new Error('create_container failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/create_container failed/);

        expect(mock_start_container).toHaveBeenCalledWith('c-pl-resume-txn');
    });

    it('restarts the previous container when metadata persistence fails after finalize', async () => {
        vi.mocked(finalize_resumed_container).mockReturnValue('c-pl-resume-txn-previous-backup');
        vi.spyOn(manifest_module, 'write_manifest').mockImplementationOnce(() => {
            throw new Error('write_manifest failed');
        });

        await expect(resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        })).rejects.toThrow(/write_manifest failed/);

        expect(mock_start_container).toHaveBeenCalledWith('c-pl-resume-txn');
    });

    it('does not restart the previous container on a successful resume', async () => {
        vi.mocked(finalize_resumed_container).mockReturnValue('c-pl-resume-txn-previous-backup');

        await resume_sandbox(patchlab_id, {
            prompter: { confirm: async () => true, choose: async () => { throw new Error('unused'); } },
        });

        expect(mock_start_container).not.toHaveBeenCalledWith('c-pl-resume-txn');
        expect(mock_start_container).toHaveBeenCalledWith('c-pl-resume-txn-resume-staging');
    });
});
