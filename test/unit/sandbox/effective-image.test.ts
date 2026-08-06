import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { create_sandbox_from_directory } from '../../test_helpers.js';
import {
    FILE_COPY_TEST_TOOL,
    ENV_VAR_TEST_TOOL,
    register_file_copy_test_tool,
    register_env_var_test_tool,
} from '../../helpers/stub_tool_provider.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initialize_repository_with_initial_commit } from '../../helpers/git_repository.js';
import type { Tool_State_Mock_State, Create_Container_Call } from '../../helpers/podman_mock_tool_state.js';

// `vi.hoisted` is required: the `vi.mock` factory below reads `state` to pass
// it to the helper's `build_tool_state_podman_mock`. The factory itself is
// hoisted above imports, so any module-level binding it references at the
// factory-body level (vs. inside a nested closure) must be hoisted too.
const state = vi.hoisted((): Tool_State_Mock_State => ({
    mock_tool_state: 'authenticated',
    mock_is_patchlab_compatible: true,
    committed_tags: [] as string[],
    committed_labels: [] as Record<string, string>[],
    cached_images: new Set<string>(),
    create_container_calls: [] as Create_Container_Call[],
}));

vi.mock('../../../src/podman.js', async (importOriginal) => {
    const { build_tool_state_podman_mock } = await import('../../helpers/podman_mock_tool_state.js');
    const podman_mock = await build_tool_state_podman_mock(state, importOriginal);
    // effective-image additionally stubs the user-path accessors so manifest
    // construction has stable home + workspace paths regardless of host OS.
    return {
        ...podman_mock,
        get_image_home: (user: string) => `/home/${user}`,
        get_working_directory: (user: string) => `/home/${user}/workspace`,
    };
});

import { install_sandbox_cleanup_hooks } from '../../helpers/sandbox_cleanup.js';
import { register_provider } from '../../../src/tools/provider.js';
import type { Authentication_Method } from '../../../src/tools/types.js';
import {
    create_container,
    install_package,
    commit_container,
    get_image_tool_state,
} from '../../../src/podman.js';

const mock_create_container = create_container as ReturnType<typeof vi.fn>;
const mock_install_package = install_package as ReturnType<typeof vi.fn>;
const mock_commit_container = commit_container as ReturnType<typeof vi.fn>;
const mock_get_image_tool_state = get_image_tool_state as ReturnType<typeof vi.fn>;

describe('effective_image tracking in create_sandbox', () => {
    // Tests each create their own uniquely-named patchlab branch in the shared
    // source repo, so one `beforeAll` fixture serves all of them. Cuts ~3 git
    // spawns per test (init+add+commit) to 3 for the whole describe.
    //
    // INVARIANT: tests in this describe SHALL NOT assert on the set or count
    // of `patchlab/*` branches in `temp_source`. Per-test cleanup runs
    // `destroy_sandbox(id, { force: true })` (via `install_sandbox_cleanup_hooks`)
    // wrapped in a try/catch that swallows errors; if a mocked-podman edge
    // case rejects a teardown call, the per-test `patchlab/{uuid}` branch is
    // left on `temp_source` for the rest of the suite. UUIDs prevent name
    // collisions across tests, so per-test assertions (image tags, label
    // values, `manifest.effective_image`) stay valid — but anything that
    // counts or enumerates branches across tests would see the leak.
    // `afterAll` discards the whole repo, so the leak is bounded to this
    // suite's lifetime.
    let temp_source: string;
    const { track } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-effective-test-'));
        initialize_repository_with_initial_commit(temp_source);
        register_file_copy_test_tool();
        register_env_var_test_tool();
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        state.committed_tags = [];
        state.committed_labels = [];
        state.cached_images = new Set();
        state.mock_is_patchlab_compatible = true;
        state.mock_tool_state = 'authenticated';
        mock_create_container.mockClear();
        mock_install_package.mockClear();
        mock_commit_container.mockClear();
    });

    it('sets effective_image to original when tool state is authenticated', async () => {
        state.mock_tool_state = 'authenticated';
        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'myimage-auth:latest',
            no_install: true,
            allow_dirty_tree: true,
        }));
        expect(manifest.effective_image).toBe('myimage-auth:latest');
        expect(state.committed_tags).toHaveLength(0);
    });

    it('commits auth tag with tool label when tool state is not authenticated', async () => {
        state.mock_tool_state = 'installed';
        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'patchlab/node-22-slim:latest',
            no_install: true,
            allow_dirty_tree: true,
        }));
        expect(manifest.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        expect(state.committed_tags).toContain('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        // Should have per-tool label
        const auth_commit = state.committed_labels.find(l => l['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']);
        expect(auth_commit).toBeDefined();
        expect(auth_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']).toBe('authenticated');
    });

    it('installs git and commits base + auth when image is not patchlab compatible', async () => {
        state.mock_tool_state = 'absent';
        state.mock_is_patchlab_compatible = false;
        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            allow_dirty_tree: true,
        }));
        expect(mock_install_package).toHaveBeenCalled();
        expect(state.committed_tags).toContain('patchlab/node-22-slim:latest');
        expect(state.committed_tags).toContain('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        expect(manifest.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
    });

    it('records tool name in manifest', async () => {
        state.mock_tool_state = 'authenticated';
        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'myimage:latest',
            no_install: true,
            allow_dirty_tree: true,
        }));
        expect(manifest.tool).toBe('patchlab-test-tool-file-copy');
    });

    it('effective_image is persisted in manifest on disk', async () => {
        state.mock_tool_state = 'installed';
        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'patchlab/node-22-slim:latest',
            no_install: true,
            allow_dirty_tree: true,
        }));
        const manifest_dir = path.join(os.homedir(), '.patchlab', manifest.id);
        const raw = JSON.parse(fs.readFileSync(path.join(manifest_dir, 'manifest.json'), 'utf-8'));
        expect(raw.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        expect(raw.tool).toBe('patchlab-test-tool-file-copy');
    });
});

describe('image caching in create_sandbox', () => {
    let temp_source: string;
    const { track } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cache-test-'));
        initialize_repository_with_initial_commit(temp_source);
        register_file_copy_test_tool();
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        state.committed_tags = [];
        state.committed_labels = [];
        state.cached_images = new Set();
        state.mock_is_patchlab_compatible = false;
        state.mock_tool_state = 'absent';
        mock_create_container.mockClear();
        mock_install_package.mockClear();
        mock_commit_container.mockClear();
        // Reset get_image_tool_state to the default implementation in case a
        // previous test in this describe block installed a per-image override.
        mock_get_image_tool_state.mockImplementation(
            (_image: string, _tool: string) => state.mock_tool_state
        );
    });

    it('force_rebuild ignores cache and uses original image', async () => {
        state.cached_images.add('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        state.cached_images.add('patchlab/node-22-slim:latest');
        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            force_rebuild: true,
            allow_dirty_tree: true,
        }));
        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            'node:22-slim',
            expect.anything()
        );
        expect(mock_install_package).toHaveBeenCalled();
        expect(manifest.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
    });

    it('reuses a cached installed-tag at "installed" state (no-auth path)', async () => {
        // Post-cleanup behavior for the "tool installed, no auth injected"
        // state: the build flow commits at `<base>-<tool>:latest` (no `-auth`
        // suffix) with label `installed`. Subsequent creates whose auth
        // result is still `none` hit this tag via `resolve_effective_image`'s
        // installed-tag probe and reuse the image — no fall-through to the
        // raw image, no re-run of `install_package`, no fresh commit.
        const expected_installed_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy:latest';
        state.cached_images.add(expected_installed_tag);
        // Per-image label dispatch: original raw image has no per-tool state
        // (realistic for an upstream image like `node:22-slim`); installed-tag
        // has the `installed` label.
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            return (image === expected_installed_tag) ? 'installed' : 'absent';
        });

        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            allow_dirty_tree: true,
        }));

        // gemini_cli_oauth is a file_copy provider; its mocked inject_authentication
        // returns { type: 'file_copy' }. The cache hit at installed-tag means
        // the install_package call is skipped (no rebuild), but the commit
        // upgrades the cached image to the auth-tag because auth WAS injected
        // this run.
        expect(mock_install_package).not.toHaveBeenCalled();
        expect(state.committed_tags).toContain('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        expect(manifest.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        // `create_container` was invoked against the cached installed-tag, not the raw image.
        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            expected_installed_tag,
            expect.anything()
        );
    });

    it('lookup chain prefers auth-tag when both forms exist (priority: auth > installed > base > absent)', async () => {
        // resolve_effective_image probes auth-tag first; when it hits with the
        // correct `authenticated` label, the installed-tag and base probes are
        // skipped. With both tag forms present, the auth-tag form wins.
        const auth_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest';
        const installed_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy:latest';
        state.cached_images.add(auth_tag);
        state.cached_images.add(installed_tag);
        // Per-image label dispatch: original raw image has no per-tool state;
        // auth-tag has `authenticated`; installed-tag has `installed`. The
        // global `state.mock_tool_state` cannot express per-image state, so override.
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            if (image === auth_tag) {
                return 'authenticated';
            }

            return (image === installed_tag) ? 'installed' : 'absent';
        });

        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            allow_dirty_tree: true,
        }));

        // Cache hit at auth-tag; no install or commit. The installed-tag was
        // present in the cache but never probed because the auth-tag won.
        expect(mock_install_package).not.toHaveBeenCalled();
        expect(state.committed_tags).toHaveLength(0);
        expect(manifest.effective_image).toBe(auth_tag);
        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            auth_tag,
            expect.anything()
        );
    });

    it('cache hit at installed-tag with auth result non-none upgrades by committing at auth-tag', async () => {
        // Spec scenario "No-auth cache hit for environment_variables provider
        // with vars now set rebuilds at auth tag": the installed-tag cache hit
        // serves as the BASE for the new build — install_package is skipped
        // (the tool is already in the cached image) — and the post-create auth
        // injection upgrades the image by committing at the auth-tag form.
        // The original installed-tag image stays cached (now an orphan-by-
        // upgrade, untagged after commit but still in podman until pruned).
        const installed_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy:latest';
        const auth_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest';
        state.cached_images.add(installed_tag);
        // Per-image label dispatch: no auth-tag exists; installed-tag has the
        // `installed` label (consistent); original image is absent.
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            return (image === installed_tag) ? 'installed' : 'absent';
        });

        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            allow_dirty_tree: true,
        }));

        // Cache hit at installed-tag → install_package SKIPPED (tool already
        // present in the cached image).
        expect(mock_install_package).not.toHaveBeenCalled();
        // patchlab-test-tool-file-copy is file_copy; its mocked inject_authentication returns
        // { type: 'file_copy' }, so the dispatch commits at the auth-tag with
        // `authenticated` label — upgrading from installed to authenticated.
        const auth_upgrade_commit = state.committed_labels.find(l =>
            l['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy'] === 'authenticated'
        );
        expect(auth_upgrade_commit).toBeDefined();
        expect(state.committed_tags).toContain(auth_tag);
        expect(manifest.effective_image).toBe(auth_tag);
        // create_container was invoked against the cached installed-tag (the
        // upgrade base), NOT the raw image and NOT the eventual auth-tag.
        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            installed_tag,
            expect.anything()
        );
    });

    it('treats an auth-tag with "installed" label as a cache miss (migration of orphaned pre-cleanup images)', async () => {
        // Migration affordance from auth-tag-schema-cleanup task 2.2: an
        // auth-tag image whose per-tool label is `installed` (not
        // `authenticated`) is inconsistent state — an artifact of the
        // pre-cleanup misnomer era when `'environment_variables'` providers
        // with unset variables committed at the auth-tag form regardless. The
        // lookup chain MUST treat this as a miss and fall through to the
        // installed-tag probe. With no installed-tag present either, the
        // lookup falls all the way through to the original image and a
        // fresh build runs.
        const orphan_auth_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest';
        state.cached_images.add(orphan_auth_tag);
        // Per-image label dispatch: original raw image has no per-tool state;
        // orphan auth-tag carries the inconsistent `installed` label.
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            return (image === orphan_auth_tag) ? 'installed' : 'absent';
        });

        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            allow_dirty_tree: true,
        }));

        // The orphaned auth-tag was NOT reused; the lookup fell through and
        // `set_up_image_tier` rebuilt from scratch (install_package ran).
        expect(mock_install_package).toHaveBeenCalled();
        // The fresh build committed at the auth-tag (gemini_cli_oauth injects
        // file_copy auth) — same tag as the orphan, but with the correct
        // `authenticated` label this time.
        const auth_commit = state.committed_labels.find(l => l['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']);
        expect(auth_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']).toBe('authenticated');
        expect(manifest.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
    });

    it('treats an installed-tag with "authenticated" label as a cache miss (symmetric consistency check)', async () => {
        // Symmetric to the previous test: the installed-tag probe in
        // resolve_effective_image enforces the strict `=== 'installed'`
        // label match. An installed-tag image whose per-tool label is
        // `authenticated` is inconsistent state and SHALL be treated as a
        // cache miss, falling through to the base probe. Locks in the
        // reverse direction of the tag-form-must-match-label rule from
        // auth-tag-schema-cleanup task 2.2 — without this test, reverting
        // the strict `=== 'installed'` check in src/sandbox/image_tier.ts to a looser
        // form (e.g., `!== 'absent'`) would silently regress.
        const inconsistent_installed_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy:latest';
        state.cached_images.add(inconsistent_installed_tag);
        // Per-image label dispatch: installed-tag (which exists) has the
        // wrong label `authenticated`; original image has none.
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            return (image === inconsistent_installed_tag) ? 'authenticated' : 'absent';
        });

        const manifest = track(await create_sandbox_from_directory(temp_source, {
            tool: FILE_COPY_TEST_TOOL,
            image: 'node:22-slim',
            no_install: true,
            allow_dirty_tree: true,
        }));

        // The inconsistent installed-tag was NOT reused as the installed
        // form; the lookup fell through and `set_up_image_tier` rebuilt
        // from scratch (install_package ran).
        expect(mock_install_package).toHaveBeenCalled();
        // patchlab-test-tool-file-copy is file_copy; the rebuild committed at the auth-tag
        // with the correct `authenticated` label.
        const auth_commit = state.committed_labels.find(l => l['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']);
        expect(auth_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']).toBe('authenticated');
        expect(manifest.effective_image).toBe('patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest');
        // create_container was invoked against the raw image (lookup
        // fell all the way through), not the inconsistent installed-tag.
        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            'node:22-slim',
            expect.anything()
        );
    });
});

describe('environment_variables authentication flow in create_sandbox', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();
    const original_env = process.env;

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-envvar-test-'));
        initialize_repository_with_initial_commit(temp_source);
        register_env_var_test_tool();
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        state.committed_tags = [];
        state.committed_labels = [];
        state.cached_images = new Set();
        state.mock_is_patchlab_compatible = true;
        state.mock_tool_state = 'installed';
        mock_create_container.mockClear();
        process.env = { ...original_env, TEST_API_KEY: 'test-key-123' };
    });

    afterEach(() => {
        process.env = original_env;
    });

    it('passes TEST_API_KEY as extra_environment_variables to create_container', async () => {
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'prebaked-sandbox:1.0',
            tool: ENV_VAR_TEST_TOOL,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.objectContaining({
                extra_environment_variables: { TEST_API_KEY: 'test-key-123' },
            }),
        );
        expect(manifest.tool).toBe(ENV_VAR_TEST_TOOL);
    });

    it('commits at auth-tag with ready label when environment_variables result has entries', async () => {
        // separate-authenticated-state: `{ type: 'environment_variables',
        // entries: [...] }` (non-empty entries) → auth-tag with `'ready'`.
        // Prior to this change, environment-variable-method providers also wrote
        // `'authenticated'` here, which overloaded that value's semantics
        // (credentials in image bytes vs. auth-attempted-at-build). The new
        // `'ready'` label preserves the auth-tag dispatch while making the
        // image-bytes-vs-runtime distinction explicit.
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'prebaked-sandbox:1.0',
            tool: ENV_VAR_TEST_TOOL,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // The commit went to the auth-tag form (not installed-tag) with
        // `'ready'` label (environment-variable provider).
        const auth_tag_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-env'] !== undefined
        );
        expect(auth_tag_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-env']).toBe('ready');
        const expected_auth_tag = state.committed_tags.find(t => t.endsWith('-patchlab-test-tool-env-auth:latest'));
        expect(expected_auth_tag).toBeDefined();
        // No installed-tag commit happened — the auth-tag dispatch is exclusive.
        const installed_tag = state.committed_tags.find(t => t.endsWith('-patchlab-test-tool-env:latest'));
        expect(installed_tag).toBeUndefined();
    });

    it('merges multiple env-var entries into extra_environment_variables (multi-entry runtime path)', async () => {
        // The spec scenario "Provider declaring environment-variable authentication
        // with multiple variables" requires that an `inject_authentication` result
        // with multiple `entries` populates `extra_environment_variables` with every
        // name/value. No built-in produces N>1 today, so register a stub provider
        // here to exercise the merge loop in `create_sandbox`.
        const multi_entry_provider = {
            name: 'stub-multi-env',
            display_name: 'Stub (multi-entry env)',
            image_specification: {
                base_image: 'docker.io/library/node:24-bookworm-slim',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: '.stub-multi',
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
            },
            inject_authentication() {
                return {
                    type: 'environment_variables' as const,
                    entries: [
                        { name: 'TOKEN_A', value: 'value-a' },
                        { name: 'TOKEN_B', value: 'value-b' },
                    ],
                };
            },
            get_launch_command() { return ['/bin/sh']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return 'stub-multi-env'; },
            get_authentication_method(): Authentication_Method { return 'environment_variables'; },
            get_extractable_artifacts() { return []; },
            async inject_session_state() { /* no-op */ },
        };
        register_provider(multi_entry_provider);

        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'stub-multi-env',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        expect(mock_create_container).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(String),
            expect.objectContaining({
                extra_environment_variables: { TOKEN_A: 'value-a', TOKEN_B: 'value-b' },
            }),
        );
    });
});

describe("'none'-method provider in create_sandbox (auth-shape Task 4.4)", () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();
    const inject_spy = vi.fn();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-none-test-'));
        initialize_repository_with_initial_commit(temp_source);
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        state.committed_tags = [];
        state.committed_labels = [];
        state.cached_images = new Set();
        state.mock_is_patchlab_compatible = true;
        state.mock_tool_state = 'absent';
        mock_create_container.mockClear();
        mock_install_package.mockClear();
        mock_commit_container.mockClear();
        inject_spy.mockReset();

        // Register a stub provider whose `get_authentication_method()` returns
        // `'none'`. No built-in returns this, so the test owns its own provider
        // and tracks `inject_authentication` invocation via a spy.
        const none_provider = {
            name: 'stub-none',
            display_name: 'Stub (none)',
            image_specification: {
                base_image: 'docker.io/library/node:24-bookworm-slim',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: '.stub-none',
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
            },
            inject_authentication: inject_spy.mockImplementation(() => ({ type: 'none' as const })),
            get_launch_command() { return ['/bin/sh']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return 'stub-none'; },
            get_authentication_method(): Authentication_Method { return 'none'; },
            get_extractable_artifacts() { return []; },
            async inject_session_state() { /* no-op */ },
        };
        register_provider(none_provider);
    });

    it('skips inject_authentication and goes through the standard image-tier flow', async () => {
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'stub-none',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // (a) inject_authentication MUST NOT be called for a `'none'`-method provider —
        // both the pre-create env-var branch and the post-create file-copy branch
        // are gated on their respective method values, so `'none'` falls through both.
        expect(inject_spy).not.toHaveBeenCalled();

        // (b) The standard image-tier flow runs — installed-tag (no `-auth`
        // suffix) committed with the `installed` label, per auth-tag-schema-
        // cleanup task 2.3. Same path a `'environment_variables'` provider
        // with unset variables follows. Subsequent creates with the same
        // auth outcome reuse this tag via the installed-tag probe in
        // `resolve_effective_image`.
        const installed_tag_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.stub-none'] !== undefined
        );
        expect(installed_tag_commit).toBeDefined();
        expect(installed_tag_commit?.['biz.ecartz.patchlab.tool.stub-none']).toBe('installed');
        expect(state.committed_tags).toContain('patchlab/node-22-slim-stub-none:latest');
        expect(state.committed_tags).not.toContain('patchlab/node-22-slim-stub-none-auth:latest');
    });
});

describe('configured-provider hash-bearing tag scheme (Section 2)', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-configured-cache-test-'));
        initialize_repository_with_initial_commit(temp_source);
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        state.committed_tags = [];
        state.committed_labels = [];
        state.cached_images = new Set();
        state.mock_is_patchlab_compatible = true;
        state.mock_tool_state = 'absent';
        mock_create_container.mockClear();
        mock_install_package.mockClear();
        mock_commit_container.mockClear();
        mock_get_image_tool_state.mockImplementation(() => state.mock_tool_state);
    });

    function make_configured(name: string, hash: string) {
        return {
            name,
            display_name: `Configured ${name}`,
            manifest_path: `/manifests/${name}.yaml`,
            manifest_hash: hash,
            image_specification: {
                base_image: 'docker.io/library/node:22-slim',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: `.${name}`,
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
            },
            inject_authentication() { return { type: 'none' as const }; },
            get_launch_command() { return ['/bin/sh']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return name; },
            get_authentication_method(): Authentication_Method { return 'none'; },
            get_extractable_artifacts() { return []; },
            async inject_session_state() { /* no-op */ },
        };
    }

    it('commits at the hash-bearing tag form for configured providers (task 2.5)', async () => {
        const provider = make_configured('aider-stub', 'abcd1234');
        register_provider(provider);

        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'patchlab/node-22-slim:latest',
            tool: 'aider-stub',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // None-method provider commits at the installed-tag form with the hash component
        expect(state.committed_tags).toContain('patchlab/node-22-slim-aider-stub-abcd1234:latest');
    });

    it('hash miss does NOT inherit state from the no-hash base-tag commits (task 2.7)', async () => {
        const provider = make_configured('aider-miss', '11112222');
        register_provider(provider);

        // Simulate the no-hash base/tool tag already existing with 'installed' state —
        // this is the orphan-tag scenario the hash-bearing dispatch must NOT inherit from.
        state.cached_images.add('patchlab/node-22-slim-aider-miss:latest');
        mock_get_image_tool_state.mockImplementation((image: string) => {
            return (image === 'patchlab/node-22-slim-aider-miss:latest') ? 'installed' : 'absent';
        });

        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'patchlab/node-22-slim:latest',
            tool: 'aider-miss',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // Should have committed at the hash-bearing tag (clean rebuild), NOT reused
        // the no-hash installed tag.
        expect(state.committed_tags).toContain('patchlab/node-22-slim-aider-miss-11112222:latest');
    });

    it('end-to-end dispatch: file_copy configured provider receives inject_authentication and commits at the hash-bearing auth-tag (W3)', async () => {
        // Use file_copy method so the dispatch flow actually invokes the configured
        // provider's inject_authentication (src/sandbox/provisioning.ts skips this call for 'none'
        // providers as an optimization).
        const inject_spy = vi.fn(() => ({ type: 'file_copy' as const }));
        const provider = {
            name: 'aider-e2e',
            display_name: 'Aider (e2e)',
            manifest_path: '/manifests/aider-e2e.yaml',
            manifest_hash: 'e2e12345',
            image_specification: {
                base_image: 'docker.io/library/node:22-slim',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: '.aider-e2e',
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
            },
            inject_authentication: inject_spy,
            get_launch_command() { return ['/bin/sh']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return 'aider-e2e'; },
            get_authentication_method(): Authentication_Method { return 'file_copy'; },
            get_extractable_artifacts() { return []; },
            async inject_session_state() { /* no-op */ },
        };
        register_provider(provider);

        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'patchlab/node-22-slim:latest',
            tool: 'aider-e2e',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // 1. inject_authentication was actually called on the configured provider
        expect(inject_spy).toHaveBeenCalled();
        // 2. The commit landed at the hash-bearing auth tag (file_copy method → authenticated label)
        expect(state.committed_tags).toContain('patchlab/node-22-slim-aider-e2e-e2e12345-auth:latest');
        // 3. The per-tool label uses the configured provider's name
        const tool_commit = state.committed_labels.find((labels) => labels['biz.ecartz.patchlab.tool.aider-e2e'] !== undefined);
        expect(tool_commit?.['biz.ecartz.patchlab.tool.aider-e2e']).toBe('authenticated');
        // 4. manifest.tool records the configured-provider name (preserves dispatch identity)
        expect(manifest.tool).toBe('aider-e2e');
    });

    it('environment_variables method accumulates two hash-bearing tag forms across runs (W4 / spec scenario)', async () => {
        // Build a configured provider whose inject_authentication consults the host
        // environment and returns either 'environment_variables' (when set) or 'none'
        // (when unset). Mirrors the synthesis class's actual behavior.
        const provider = {
            name: 'aider-env',
            display_name: 'Aider (env-var)',
            manifest_path: '/manifests/aider-env.yaml',
            manifest_hash: 'envab123',
            image_specification: {
                base_image: 'docker.io/library/node:22-slim',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: '.aider-env',
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
            },
            inject_authentication() {
                const api_key = process.env.AIDER_E2E_API_KEY;
                if (api_key !== undefined) {
                    return {
                        type: 'environment_variables' as const,
                        entries: [{ name: 'AIDER_E2E_API_KEY', value: api_key }],
                    };
                }
                return { type: 'none' as const };
            },
            get_launch_command() { return ['/bin/sh']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return 'aider-env'; },
            get_authentication_method(): Authentication_Method { return 'environment_variables'; },
            get_extractable_artifacts() { return []; },
            async inject_session_state() { /* no-op */ },
        };
        register_provider(provider);

        // First run: env var UNSET → installed (no-auth) hash tag committed.
        const original_env = { ...process.env };
        delete process.env.AIDER_E2E_API_KEY;
        try {
            const first = await create_sandbox_from_directory(temp_source, {
                image: 'patchlab/node-22-slim:latest',
                tool: 'aider-env',
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(first.id);
        } finally {
            process.env = { ...original_env };
        }
        expect(state.committed_tags).toContain('patchlab/node-22-slim-aider-env-envab123:latest');
        expect(state.committed_tags).not.toContain('patchlab/node-22-slim-aider-env-envab123-auth:latest');

        // Second run: same manifest hash, but env var SET → auth hash tag committed
        // alongside the existing installed hash tag.
        state.committed_tags.length = 0;
        state.committed_labels.length = 0;
        // The first run committed at the installed tag, so the cache lookup on the
        // second run finds that tag and uses it as the base for the auth-tag commit.
        state.cached_images.add('patchlab/node-22-slim-aider-env-envab123:latest');
        mock_get_image_tool_state.mockImplementation((image: string) => {
            return (image === 'patchlab/node-22-slim-aider-env-envab123:latest')
                ? 'installed'
                : 'absent';
        });
        process.env.AIDER_E2E_API_KEY = 'key-value';
        try {
            const second = await create_sandbox_from_directory(temp_source, {
                image: 'patchlab/node-22-slim:latest',
                tool: 'aider-env',
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(second.id);
        } finally {
            delete process.env.AIDER_E2E_API_KEY;
        }
        expect(state.committed_tags).toContain('patchlab/node-22-slim-aider-env-envab123-auth:latest');
        const auth_commit = state.committed_labels.find((labels) => labels['biz.ecartz.patchlab.tool.aider-env'] !== undefined);
        // aider-env is an environment-variable-method configured provider,
        // so post-`separate-authenticated-state` it commits with `'ready'`
        // (not`'authenticated'`) when the var is set at build time.
        expect(auth_commit?.['biz.ecartz.patchlab.tool.aider-env']).toBe('ready');
    });
});
