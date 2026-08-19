import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
    build_session_path,
    write_session_metadata,
    type Session_Metadata,
} from '../../../src/archive.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';
import { register_default_test_tool } from '../../helpers/stub_tool_provider.js';

const mock_finalize_session_metadata = vi.fn();
const mock_extract_history = vi.fn();
const mock_extract_conversation = vi.fn().mockReturnValue({ produced_but_failed: [] });
const mock_extract_workspace_copies = vi.fn();
const mock_commit_session_to_branch = vi.fn().mockResolvedValue({
    commit_shas: { '/tmp/repo': 'abc123' },
    fallback_patches: { '/tmp/repo': null },
});

vi.mock('../../../src/extraction.js', () => ({
    extract_history: (...args: unknown[]) => mock_extract_history(...args),
    extract_conversation: (...args: unknown[]) => mock_extract_conversation(...args),
    finalize_session_metadata: (...args: unknown[]) => mock_finalize_session_metadata(...args),
}));

vi.mock('../../../src/sandbox/workspace_copies.js', () => ({
    extract_workspace_copies: (...args: unknown[]) => mock_extract_workspace_copies(...args),
}));

vi.mock('../../../src/branch/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/branch/index.js')>();
    return {
        ...actual,
        commit_session_to_branch: (...args: unknown[]) => mock_commit_session_to_branch(...args),
    };
});

import { extract_session_to_branch } from '../../../src/cli.js';
import type { Sandbox_Manifest } from '../../../src/manifest.js';

describe('extract_session_to_branch session resolution', () => {
    install_isolated_home_hooks('patchlab-extract-session-home-');

    const patchlab_id = 'pl-extract-session';
    const repository_root = '/tmp/repo';

    function make_metadata(session_number: number): Session_Metadata {
        return {
            session_number,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'patchlab-test-tool',
            container_name: 'patchlab-test-container',
            commit_shas: { [repository_root]: null },
            fallback_patches: { [repository_root]: null },
            resource_limits: null,
        };
    }

    function make_manifest(): Sandbox_Manifest {
        return {
            id: patchlab_id,
            format_version: 0,
            sources: [{
                host_path: repository_root,
                repository_root,
                source_prefix: '',
                mount_name: 'repo',
            }],
            baseline_commit_shas: { [repository_root]: null },
            branch_creation_point_shas: { [repository_root]: 'deadbeef' },
            created_at: '2026-04-25T00:00:00.000Z',
            container_name: 'patchlab-test-container',
            container_image: 'patchlab/test:latest',
            tool: 'patchlab-test-tool',
        };
    }

    beforeEach(() => {
        register_default_test_tool();
        mock_finalize_session_metadata.mockClear();
        mock_extract_history.mockClear();
        mock_extract_conversation.mockClear();
        mock_extract_workspace_copies.mockClear();
        mock_commit_session_to_branch.mockClear();
    });

    it('extracts the latest session that has metadata when a higher session directory is metadata-less', async () => {
        write_session_metadata(patchlab_id, 1, make_metadata(1));
        fs.mkdirSync(build_session_path(patchlab_id, 2), { recursive: true });

        await extract_session_to_branch(make_manifest(), '/workspace/repo', null);

        expect(mock_finalize_session_metadata).toHaveBeenCalledWith(patchlab_id, 1, 'completed');
        expect(mock_extract_history).toHaveBeenCalledWith(
            'patchlab-test-container',
            '/workspace/repo',
            expect.any(String),
            patchlab_id,
            1,
        );
    });
});
