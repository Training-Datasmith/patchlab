/**
 * Focused tests for `create_sandbox`'s rollback paths. The happy path of
 * `create_sandbox` is exercised by the integration suite (~10 files under
 * `test/integration/`), which is the only place the full chain of
 * podman + git + provider + manifest writes is realistic. The two rollback
 * paths, however, are reachable cheaply via targeted mocks:
 *
 *   1. **Phase-2 mutations throw** → the `catch` at the top of `create_sandbox`
 *      rolls back any branches Phase 2 created and removes the archive
 *      directory before re-throwing.
 *   2. **`provision_new_sandbox` throws** → a second `catch` calls
 *      `rollback_failed_create`, which stops/removes the container,
 *      force-deletes the Phase-2 branches, and removes the archive directory.
 *
 * Both paths are tested with minimal mocks: the chain stops at the throw
 * site, so the dozens of downstream functions never get reached.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_TEST_TOOL } from '../../helpers/stub_tool_provider.js';

vi.mock('../../../src/sandbox/branch_handshake.js', () => ({
    collect_unique_repositories: vi.fn((sources: { repository_root: string }[]) =>
        Array.from(new Set(sources.map((source) => source.repository_root))),
    ),
    execute_phase_1_preflight: vi.fn(async () => new Set<string>()),
    execute_phase_2_mutations: vi.fn(),
    rollback_phase_2_created_branches: vi.fn(),
    validate_source_paths: vi.fn(),
}));

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
    container_name_for: vi.fn((id: string) => `c-${id}`),
    container_running: vi.fn(() => false),
    create_container: vi.fn(),
    query_running_containers: vi.fn(() => []),
    start_container: vi.fn(),
    stop_and_remove_container_best_effort: vi.fn(),
    was_authentication_attempted_at_build: vi.fn(() => false),
}));

vi.mock('../../../src/sandbox/image_tier.js', () => ({
    resolve_effective_image: vi.fn(() => ({
        effective_image: 'node:22-slim',
        tool_state: 'absent',
    })),
    set_up_image_tier: vi.fn(() => 'node:22-slim'),
}));

vi.mock('../../../src/resource_limits.js', () => ({
    UNLIMITED: -1,
    resolve_resource_limits: vi.fn(() => ({
        memory_limit: -1,
        cpu_limit: -1,
        pids_limit: -1,
        blkio_weight: null,
    })),
    resolved_limits_to_create_options: vi.fn(() => ({
        memory_limit: undefined,
        cpu_limit: undefined,
        pids_limit: undefined,
        blkio_weight: undefined,
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
    get_provider: vi.fn(() => ({
        image_specification: { image_home: '/home/patchlab' },
        get_authentication_method: () => 'none',
        inject_authentication: vi.fn(),
        inject_session_state: vi.fn(),
    })),
    register_per_source_manifests: vi.fn(() => ({
        manifest_buffers: new Map(),
        registered_manifests: [],
        registered_manifest_repositories: [],
        errors: [],
    })),
}));

vi.mock('../../../src/tools/configured_provider/trust_verification.js', () => ({
    verify_per_source_trust_multi_repository: vi.fn(),
}));

import {
    execute_phase_1_preflight,
    execute_phase_2_mutations,
    rollback_phase_2_created_branches,
} from '../../../src/sandbox/branch_handshake.js';
import { stop_and_remove_container_best_effort } from '../../../src/podman.js';
import { create_sandbox } from '../../../src/sandbox/index.js';
import { build_archive_path } from '../../../src/archive.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

const mocked_phase_1 = vi.mocked(execute_phase_1_preflight);
const mocked_phase_2 = vi.mocked(execute_phase_2_mutations);
const mocked_rollback_branches = vi.mocked(rollback_phase_2_created_branches);
const mocked_stop_container = vi.mocked(stop_and_remove_container_best_effort);

describe('create_sandbox rollback paths', () => {
    install_isolated_home_hooks('patchlab-create-rollback-');
    let source_directory: string;

    beforeEach(() => {
        mocked_phase_1.mockReset();
        mocked_phase_2.mockReset();
        mocked_rollback_branches.mockReset();
        mocked_stop_container.mockReset();
        mocked_phase_1.mockResolvedValue(new Set());
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-create-source-')));
    });

    it('rolls back Phase 2 branches and removes the archive directory when Phase 2 throws', async () => {
        // Drive Phase 2 to populate the tracked-branch list AND then throw,
        // simulating a partial-success failure (some branches created before
        // a later repository failed). The catch must force-delete every
        // tracked branch even when phase_2 itself raised.
        mocked_phase_2.mockImplementation((_repositories, _id, _dirty, created_branch_repositories) => {
            created_branch_repositories.push(source_directory);
            throw new Error('phase 2 failure');
        });
        // The catch block does `created_branch_repositories.length = 0` AFTER
        // passing the array to rollback — snapshot via the rollback mock's
        // implementation so the assertion sees the pre-clear contents.
        const snapshot: { repositories: string[]; patchlab_id: string }[] = [];
        mocked_rollback_branches.mockImplementation((repositories, patchlab_id) => {
            snapshot.push({ repositories: [...repositories], patchlab_id });
        });

        await expect(create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            { tool: DEFAULT_TEST_TOOL },
        )).rejects.toThrow(/phase 2 failure/);

        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].repositories).toEqual([source_directory]);
        expect(typeof snapshot[0].patchlab_id).toBe('string');

        // The archive directory was removed even though Phase 2 raised partway.
        const patchlab_id = snapshot[0].patchlab_id;
        expect(fs.existsSync(build_archive_path(patchlab_id))).toBe(false);

        // No container cleanup is needed on the Phase-2 path since no
        // container was ever created.
        expect(mocked_stop_container).not.toHaveBeenCalled();
    });

    it('runs rollback_failed_create when provision_new_sandbox throws (after Phase 2 succeeded)', async () => {
        // Phase 2 succeeds (returns baseline maps); provision_new_sandbox then
        // fails downstream — we simulate this by having create_container throw.
        mocked_phase_2.mockImplementation((_repositories, _id, _dirty, created_branch_repositories) => {
            created_branch_repositories.push(source_directory);
            return {
                baseline_commit_shas: { [source_directory]: null },
                branch_creation_point_shas: { [source_directory]: null },
            };
        });
        const snapshot: { repositories: string[]; patchlab_id: string }[] = [];
        mocked_rollback_branches.mockImplementation((repositories, patchlab_id) => {
            snapshot.push({ repositories: [...repositories], patchlab_id });
        });
        const { create_container } = await import('../../../src/podman.js');
        vi.mocked(create_container).mockImplementation(() => {
            throw new Error('create_container failed');
        });

        await expect(create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            { tool: DEFAULT_TEST_TOOL },
        )).rejects.toThrow(/create_container failed/);

        // rollback_failed_create's three side effects ran:
        //   (a) stop and remove the (never-started) container — best-effort,
        //   (b) force-delete every Phase-2-created branch,
        //   (c) remove the archive directory.
        expect(mocked_stop_container).toHaveBeenCalledTimes(1);
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].repositories).toEqual([source_directory]);
        const patchlab_id = snapshot[0].patchlab_id;
        expect(fs.existsSync(build_archive_path(patchlab_id))).toBe(false);
    });
});
