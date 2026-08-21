import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox } from '../../../src/sandbox/index.js';
import { install_isolated_patchlab_home_hooks } from '../../helpers/home_directory.js';
import { loaded_configuration_with_resource_limits } from '../../../src/configuration.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../../helpers/stub_tool_provider.js';

const { mock_verify_per_source_default_tool } = vi.hoisted(() => ({
    mock_verify_per_source_default_tool: vi.fn(async (..._arguments_list: unknown[]) => ({ override: null })),
}));

vi.mock('../../../src/sandbox/branch_handshake.js', () => ({
    collect_unique_repositories: vi.fn((sources: { repository_root: string }[]) =>
        Array.from(new Set(sources.map((source) => source.repository_root))),
    ),
    execute_phase_1_preflight: vi.fn(async () => new Set<string>()),
    execute_phase_2_mutations: vi.fn(() => {
        throw new Error('stop-after-tool-check');
    }),
    rollback_phase_2_created_branches: vi.fn(),
    validate_source_paths: vi.fn(),
}));

vi.mock('../../../src/detect/index.js', () => ({
    detect_requirements: vi.fn(() => ({
        system_packages: [],
        volume_mounts: [],
        environment_variables: [],
        services: [],
        npm_packages: [],
    })),
}));

vi.mock('../../../src/overrides.js', () => ({
    load_overrides: vi.fn(() => ({
        system_packages: [],
        volume_mounts: [],
        environment_variables: [],
        services: [],
        npm_packages: [],
    })),
}));

vi.mock('../../../src/overrides_merge.js', () => ({
    merge_requirements: vi.fn((_detected, overrides) => overrides),
    merge_service_selections: vi.fn((requirements) => requirements),
    merge_npm_packages: vi.fn((_detected, caller) => caller),
}));

vi.mock('../../../src/prompts.js', () => ({
    resolve_socket_mount: vi.fn(async () => ({ approved: false })),
}));

vi.mock('../../../src/services.js', () => ({
    resolve_services: vi.fn(async () => []),
    merge_service_selections: vi.fn((requirements) => requirements),
}));

vi.mock('../../../src/stale.js', () => ({
    check_stale_image: vi.fn(() => ({ stale: false, no_label: false, missing: [] })),
}));

vi.mock('../../../src/cgroups.js', () => ({
    warn_once_if_unsupported: vi.fn(),
}));

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

vi.mock('../../../src/tools/configured_provider/trust_verification.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/tools/configured_provider/trust_verification.js')>();
    return {
        ...actual,
        verify_per_source_trust_multi_repository: vi.fn(),
    };
});

vi.mock('../../../src/tools/default_tool_trust.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/tools/default_tool_trust.js')>();
    return {
        ...actual,
        verify_per_source_default_tool: (...arguments_list: Parameters<typeof actual.verify_per_source_default_tool>) =>
            mock_verify_per_source_default_tool(...arguments_list),
    };
});

describe('create_sandbox default tool resolution', () => {
    install_isolated_patchlab_home_hooks('patchlab-create-default-tool-');
    let source_directory: string;

    beforeEach(() => {
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-create-default-tool-src-')));
        mock_verify_per_source_default_tool.mockReset();
        mock_verify_per_source_default_tool.mockResolvedValue({ override: null });
        register_default_test_tool();
    });

    afterEach(() => {
        mock_verify_per_source_default_tool.mockReset();
        mock_verify_per_source_default_tool.mockResolvedValue({ override: null });
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('throws when options.tool is empty', async () => {
        await expect(create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            { tool: '' },
        )).rejects.toThrow(/non-empty options\.tool/);
        expect(mock_verify_per_source_default_tool).not.toHaveBeenCalled();
    });

    it('calls verify_per_source_default_tool when options.tool is omitted', async () => {
        const loaded_configuration = loaded_configuration_with_resource_limits(null, null);
        let create_error: unknown;
        try {
            await create_sandbox(
                [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
                { loaded_configuration },
            );
        } catch (error) {
            create_error = error;
        }

        expect(mock_verify_per_source_default_tool).toHaveBeenCalledTimes(1);
        expect(mock_verify_per_source_default_tool).toHaveBeenCalledWith(
            [source_directory],
            loaded_configuration,
            expect.objectContaining({
                prompter: null,
                allow_untrusted_default_tool: undefined,
            }),
        );
        expect(create_error).toBeDefined();
    });

    it('skips verify_per_source_default_tool when options.tool is set', async () => {
        let create_error: unknown;
        try {
            await create_sandbox(
                [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
                { tool: DEFAULT_TEST_TOOL },
            );
        } catch (error) {
            create_error = error;
        }

        expect(mock_verify_per_source_default_tool).not.toHaveBeenCalled();
        expect(create_error).toBeDefined();
    });

    it('forwards allow_untrusted_default_tool to verify_per_source_default_tool', async () => {
        let create_error: unknown;
        try {
            await create_sandbox(
                [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
                { allow_untrusted_default_tool: true },
            );
        } catch (error) {
            create_error = error;
        }

        expect(mock_verify_per_source_default_tool).toHaveBeenCalledWith(
            [source_directory],
            expect.anything(),
            expect.objectContaining({ allow_untrusted_default_tool: true }),
        );
        expect(create_error).toBeDefined();
    });
});
