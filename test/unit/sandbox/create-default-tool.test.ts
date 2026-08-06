import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox } from '../../../src/sandbox/index.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

vi.mock('../../../src/sandbox/branch_handshake.js', () => ({
    collect_unique_repositories: vi.fn((sources: { repository_root: string }[]) =>
        Array.from(new Set(sources.map((source) => source.repository_root))),
    ),
    execute_phase_1_preflight: vi.fn(async () => new Set<string>()),
    execute_phase_2_mutations: vi.fn(async () => {
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
    resolve_services: vi.fn(async () => []),
}));

vi.mock('../../../src/stale.js', () => ({
    check_stale_image: vi.fn(() => ({ stale: false, no_label: false, missing: [] })),
}));

vi.mock('../../../src/tools/configured_provider/trust_verification.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/tools/configured_provider/trust_verification.js')>();
    return {
        ...actual,
        verify_per_source_trust_multi_repository: vi.fn(),
    };
});

describe('create_sandbox requires options.tool', () => {
    install_isolated_home_hooks('patchlab-create-default-tool-');
    let source_directory: string;

    beforeEach(() => {
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-create-default-tool-')));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('throws when options.tool is omitted', async () => {
        await expect(create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
        )).rejects.toThrow(/create_sandbox requires options\.tool/);
    });

    it('throws when options.tool is empty', async () => {
        await expect(create_sandbox(
            [{ host_path: source_directory, repository_root: source_directory, source_prefix: '', mount_name: '' }],
            { tool: '' },
        )).rejects.toThrow(/create_sandbox requires options\.tool/);
    });
});
