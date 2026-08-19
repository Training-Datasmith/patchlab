// `resume_sandbox` active-sandbox guard (the `confirm_active_sandbox_if_needed`
// helper in src/sandbox/provisioning.ts). Throws when the patchlab already
// has an existing container (running OR stopped) AND either no confirm hook
// was supplied OR the confirm hook declined. Mocks `container_exists` and
// `container_running` from `./podman.js` so the guard fires without needing
// real podman state — every test here exercises the STOPPED-container path:
// the container is known to exist (mocked true) but is not running (mocked false).
//
// Why a SEPARATE file from `test/unit/resume-guards.test.ts`: those tests run
// the real `container_exists` against ENOENT-tolerant podman paths, so a
// top-of-file `vi.mock('./podman.js')` here would corrupt those tests if added
// to the shared file. Isolation by file is the cleanest way to scope the mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { make_fake_prompter } from '../helpers/fake_prompter.js';

// IMPORTANT: vi.mock is hoisted ABOVE the imports below it, so the
// `resume_sandbox` import on the next line resolves with the mocked
// `container_running`. Every OTHER export of `./podman.js` must still flow
// through (the actual module is large; many src/ files import other names).
vi.mock('../../src/container_runtime.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/container_runtime.js')>('../../src/container_runtime.js');
    return {
        ...actual,
        container_exists: vi.fn(() => true),
        container_running: vi.fn(() => false),
    };
});

import { resume_sandbox } from '../../src/sandbox/index.js';
import { create_patchlab_branch } from '../../src/branch/index.js';
import { build_archive_path } from '../../src/archive.js';
import { create_manifest, write_manifest } from '../../src/manifest.js';
import { initialize_repository_with_initial_commit } from '../helpers/git_repository.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';

describe('resume_sandbox — active-sandbox guard (container_exists mocked)', () => {
    install_isolated_home_hooks('patchlab-active-guard-home-');
    let repository: string;
    const patchlab_id = 'pl-active-guard';

    beforeEach(() => {
        register_default_test_tool();
        // Build a real single-repository fixture so the reachability pre-flight
        // (which runs BEFORE the active-sandbox guard) passes.
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-active-guard-repo-')));
        initialize_repository_with_initial_commit(repository);
        create_patchlab_branch(repository, patchlab_id);

        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: 'src' }],
            'patchlab-test',
            'patchlab/test:latest',
        );
        manifest.tool = DEFAULT_TEST_TOOL;
        write_manifest(archive_directory, manifest);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('throws "already has an existing container" when no prompter is supplied', async () => {
        await expect(resume_sandbox(patchlab_id)).rejects.toThrow(
            new RegExp(`Patchlab ${patchlab_id} already has an existing container`),
        );
        await expect(resume_sandbox(patchlab_id)).rejects.toThrow(
            /pass prompter or remove the container first/,
        );
    });

    it('runs provider_preflight before active-sandbox guard', async () => {
        await expect(resume_sandbox(patchlab_id, {
            provider_preflight: () => {
                throw new Error('provider preflight failed');
            },
        })).rejects.toThrow(/provider preflight failed/);
        await expect(resume_sandbox(patchlab_id, {
            provider_preflight: () => {
                throw new Error('provider preflight failed');
            },
        })).rejects.not.toThrow(/already has an existing container/);
    });

    it('throws "Resume aborted" when prompter declines', async () => {
        // The interactive branch: the operator declined when prompted about
        // an already-existing container. The throw is the load-bearing signal
        // that the user's intent was respected — silently no-op'ing here would
        // leave the operator unsure whether the resume happened.
        await expect(
            resume_sandbox(patchlab_id, { prompter: make_fake_prompter({ confirm: [false] }) }),
        ).rejects.toThrow(/Resume aborted: user declined to create another sandbox/);
    });

    it('proceeds past the guard when prompter confirms (no guard throw observed)', async () => {
        // The positive case: confirming proceeds past the guard. The call
        // will fail later in the resume pipeline (no real podman) but NOT on
        // the active-sandbox-guard message. The `not.toThrow(/active sandbox/)`
        // assertion catches a regression that would, for example, run the
        // guard a second time after confirm or rely on a non-existent flag.
        await expect(
            resume_sandbox(patchlab_id, { prompter: make_fake_prompter({ confirm: () => true }) }),
        ).rejects.not.toThrow(/already has an active sandbox/);
        await expect(
            resume_sandbox(patchlab_id, { prompter: make_fake_prompter({ confirm: () => true }) }),
        ).rejects.not.toThrow(/Resume aborted/);
    });
});
