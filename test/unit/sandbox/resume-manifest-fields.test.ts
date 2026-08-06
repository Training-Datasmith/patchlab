/**
 * Unit tests for manifest-field persistence and restore (patchlab-resume tasks 5.1–5.3).
 *
 * Task 5.1 — create_sandbox writes volume_mounts, environment_variables, npm_packages to the
 * manifest and does NOT write auth-injected extra_environment_variables (security invariant).
 *
 * Task 5.2 — resume_sandbox reads the three new fields from the manifest via a real disk
 * round-trip (write_manifest → resume_sandbox → read_manifest internally) and passes them
 * correctly to create_container and install_npm_packages.
 *
 * Task 5.3 — resume_sandbox completes without throwing and logs a warning when one npm
 * package installation fails (best-effort degradation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_TEST_TOOL } from '../../helpers/stub_tool_provider.js';

vi.mock('../../../src/sandbox/branch_handshake.js', () => ({
    collect_unique_repositories: vi.fn((sources: { repository_root: string }[]) =>
        Array.from(new Set(sources.map((s) => s.repository_root)))
    ),
    execute_phase_1_preflight: vi.fn(async () => new Set()),
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

vi.mock('../../../src/podman.js', () => ({
    DEFAULT_IMAGE: 'node:22-slim',
    container_exists: vi.fn(() => false),
    container_name_for: vi.fn((id: string) => `c-${id}`),
    container_running: vi.fn(() => false),
    create_container: vi.fn(),
    query_running_containers: vi.fn(() => []),
    start_container: vi.fn(),
    stop_and_remove_container_best_effort: vi.fn(),
    was_authentication_attempted_at_build: vi.fn(() => false),
}));

vi.mock('../../../src/sandbox/image_tier.js', () => ({
    resolve_effective_image: vi.fn(() => ({ effective_image: 'node:22-slim', tool_state: 'absent' })),
    set_up_image_tier: vi.fn(() => 'node:22-slim'),
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

vi.mock('../../../src/tools/index.js', () => ({
    compute_container_workspace_path: vi.fn(() => '/home/patchlab/workspace'),
    get_provider: vi.fn(),
    register_per_source_manifests: vi.fn(() => ({
        manifest_buffers: new Map<string, Buffer>(),
        registered_manifests: [],
        registered_manifest_repositories: [],
        errors: [],
    })),
}));

vi.mock('../../../src/tools/configured_provider/trust_verification.js', () => ({
    verify_per_source_trust_multi_repository: vi.fn(),
}));

vi.mock('../../../src/archive.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/archive.js')>();
    return { ...actual, latest_session_with_metadata: vi.fn(() => null) };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox, resume_sandbox } from '../../../src/sandbox/index.js';
import { build_archive_path } from '../../../src/archive.js';
import { create_manifest, write_manifest } from '../../../src/manifest.js';
import { execute_phase_2_mutations } from '../../../src/sandbox/branch_handshake.js';
import { create_container } from '../../../src/podman.js';
import { install_npm_packages } from '../../../src/sandbox/workspace_staging.js';
import { get_provider } from '../../../src/tools/index.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';
import { ConsoleLogger, set_logger } from '../../../src/logger.js';
import { RecordingLogger } from '../../helpers/recording_logger.js';
import type { Tool_Provider } from '../../../src/tools/index.js';

function make_stub_provider(overrides: Partial<Tool_Provider> = {}): Tool_Provider {
    return {
        name: 'stub-provider',
        display_name: 'Stub Provider',
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
        get_openspec_tool_name() { return 'stub'; },
        get_authentication_method: () => 'none' as const,
        get_extractable_artifacts() { return []; },
        inject_session_state: vi.fn(),
        ...overrides,
    };
}

function make_none_provider(): Tool_Provider {
    return make_stub_provider();
}

function make_environment_variables_provider(): Tool_Provider {
    return make_stub_provider({
        get_authentication_method: () => 'environment_variables' as const,
        inject_authentication: vi.fn(() => ({
            type: 'environment_variables' as const,
            entries: [{ name: 'ANTHROPIC_API_KEY', value: 'test-api-key' }],
        })),
    });
}

describe('Task 5.1 — create_sandbox writes resolved fields; auth vars excluded from manifest', () => {
    install_isolated_home_hooks('patchlab-manifest-fields-create-');
    let source_directory: string;

    beforeEach(() => {
        source_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mf-src-'))
        );
        vi.mocked(get_provider).mockReturnValue(make_environment_variables_provider());
        vi.mocked(execute_phase_2_mutations).mockImplementation(
            (_repositories, _id, _dirty, created_branches) => {
                created_branches.push(source_directory);
                return {
                    baseline_commit_shas: { [source_directory]: null },
                    branch_creation_point_shas: { [source_directory]: null },
                };
            }
        );
    });

    afterEach(() => {
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('manifest contains caller-provided volume_mounts and environment_variables', async () => {
        const manifest = await create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            {
                tool: DEFAULT_TEST_TOOL,
                volume_mounts: ['/var/run/docker.sock:/var/run/docker.sock'],
                environment_variables: { 'DOCKER_HOST': 'unix:///var/run/docker.sock' },
                npm_packages: [{ type: 'npm_package', package: 'my-tool', source: 'source_code' }],
            },
        );

        expect(manifest.volume_mounts).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
        expect(manifest.environment_variables).toEqual({ 'DOCKER_HOST': 'unix:///var/run/docker.sock' });
        expect(manifest.npm_packages).toEqual([{ type: 'npm_package', package: 'my-tool', source: 'source_code' }]);
    });

    it('manifest environment_variables does NOT contain ANTHROPIC_API_KEY from auth injection', async () => {
        const manifest = await create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            {
                tool: DEFAULT_TEST_TOOL,
                environment_variables: { 'SERVICE_VAR': 'value' },
            },
        );

        // The provider injects ANTHROPIC_API_KEY via extra_environment_variables (passed separately
        // to create_container). It must NOT appear in Sandbox_Manifest.environment_variables.
        expect(manifest.environment_variables).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(manifest.environment_variables).toEqual({ 'SERVICE_VAR': 'value' });
    });

    it('manifest writes empty arrays and empty object when options are absent', async () => {
        const manifest = await create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            { tool: DEFAULT_TEST_TOOL },
        );

        expect(manifest.volume_mounts).toEqual([]);
        expect(manifest.environment_variables).toEqual({});
        expect(manifest.npm_packages).toEqual([]);
    });
});

describe('Task 5.2 — resume_sandbox reads manifest fields via real disk round-trip', () => {
    install_isolated_home_hooks('patchlab-manifest-fields-resume-');

    const patchlab_id = 'pl-resume-fields';
    const container_name = 'old-container';

    beforeEach(() => {
        vi.mocked(get_provider).mockReturnValue(make_none_provider());

        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });

        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: '/fake/source', repository_root: '/fake/source', source_prefix: '', mount_name: '' }],
            container_name,
            'node:22-slim',
        );
        manifest.tool = 'gemini-cli-oauth';
        manifest.volume_mounts = ['/var/run/docker.sock:/var/run/docker.sock'];
        manifest.environment_variables = { 'DOCKER_HOST': 'unix:///var/run/docker.sock' };
        manifest.npm_packages = [{ type: 'npm_package', package: 'my-tool', source: 'source_code' }];
        write_manifest(archive_directory, manifest);
    });

    it('create_container receives volume_mounts and environment_variables from manifest', async () => {
        await resume_sandbox(patchlab_id);

        const call = vi.mocked(create_container).mock.calls[0];
        expect(call[2]?.volume_mounts).toEqual(['/var/run/docker.sock:/var/run/docker.sock']);
        expect(call[2]?.environment_variables).toEqual({ 'DOCKER_HOST': 'unix:///var/run/docker.sock' });
    });

    it('install_npm_packages receives npm_packages from manifest', async () => {
        await resume_sandbox(patchlab_id);

        expect(vi.mocked(install_npm_packages)).toHaveBeenCalledWith(
            expect.any(String),
            [{ type: 'npm_package', package: 'my-tool', source: 'source_code' }],
            '/home/patchlab/workspace',
        );
    });
});

describe('Task 5.3 — resume_sandbox completes when npm package install fails (best-effort)', () => {
    install_isolated_home_hooks('patchlab-manifest-fields-npm-fail-');

    const patchlab_id = 'pl-npm-fail';
    const container_name = 'old-container-npm';
    let recording: RecordingLogger;

    beforeEach(() => {
        vi.mocked(get_provider).mockReturnValue(make_none_provider());
        recording = new RecordingLogger();
        set_logger(recording);

        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });

        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: '/fake/source', repository_root: '/fake/source', source_prefix: '', mount_name: '' }],
            container_name,
            'node:22-slim',
        );
        manifest.tool = 'gemini-cli-oauth';
        manifest.npm_packages = [{ type: 'npm_package', package: 'failing-tool', source: 'source_code' }];
        write_manifest(archive_directory, manifest);

        vi.mocked(install_npm_packages).mockImplementation((_container_name, packages) => {
            for (const package_requirement of packages) {
                recording.warn(
                    `Warning: failed to install ${package_requirement.package} — simulated exec failure. You can install it manually.`
                );
            }
        });
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    it('resume completes without throwing when install_npm_packages logs a warning', async () => {
        await expect(resume_sandbox(patchlab_id)).resolves.not.toThrow();
    });

    it('a warning naming the failing package is logged', async () => {
        await resume_sandbox(patchlab_id);

        const warnings = recording.calls.filter((c) => c.method === 'warn');
        expect(warnings.some((c) => String(c.message).includes('failing-tool'))).toBe(true);
    });
});
