/**
 * End-to-end integration coverage for the four-value Tool_State surface
 * introduced by `separate-authenticated-state`. Each `describe` block
 * exercises one spec scenario against a real podman commit:
 *
 *   - 7.1: environment-variable-method commit lands with label `'ready'`
 *     (not thepre-change `'authenticated'`).
 *   - 7.2: legacy `'authenticated'` label on an environment-variable-method
 *     auth-tagimage is read-tolerated by the cache lookup AND the
 *     environment variable is still passed at create-time.
 *   - 7.3: resume of a file_copy sandbox always re-invokes
 *     `inject_authentication`, regardless of the resumed image's tool_state
 *     (regression guard against re-introducing the create-vs-resume
 *     symmetry that Decision 6 explicitly rejected).
 *
 * Stub providers are registered via `register_provider` so the tests can:
 *   - Choose the `get_authentication_method()` return value to drive the
 *     label dispatch through every branch.
 *   - Count `inject_authentication` invocations across create and resume.
 *   - Avoid depending on real Claude/Gemini credentials being present in
 *     the test environment.
 *
 * Sequential-only per `feedback_test_running`: patchlab's integration tests
 * share a single podman runtime. Each `describe` block creates and tears
 * down its own sandbox in `afterAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { create_sandbox_from_directory } from '../test_helpers.js';
import { make_fake_prompter } from '../helpers/fake_prompter.js';

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec_runtime_cli } from '../helpers/exec_runtime_cli.js';
import {
    resume_sandbox,
} from '../../src/sandbox/index.js';
import {
    build_image,
    PATCHLAB_TEST_LABEL,
    remove_test_images,
} from '../../src/images.js';
import {
    image_exists,
    commit_container,
    create_container,
    start_container,
    remove_container,
    container_exists,
    get_image_tool_state,
    is_patchlab_compatible_image,
} from '../../src/container_runtime.js';
import { register_provider } from '../../src/tools/provider.js';
import { ensure_integration_test_tool_registered } from '../test_helpers.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import type {
    Authentication_Method,
    Authentication_Result,
    Tool_Provider,
} from '../../src/tools/types.js';
import { create_integration_cleanup_registry, register_destroy_sandbox } from '../helpers/integration_cleanup.js';

const TEST_TAG = 'patchlab/tool-state-three-values-test:latest';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;

function make_source_directory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-three-values-int-'));
    execFileSync('git', ['init'], { cwd: directory });
    fs.writeFileSync(path.join(directory, 'README.md'), '# test\n');
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
            GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
        },
    });
    return directory;
}

/**
 * Build a stub provider. The factory lets each `describe` block pick its
 * `get_authentication_method()` and supply its own `inject_authentication`
 * implementation (for counting calls or returning a chosen result type).
 */
function make_stub_provider(options: {
    name: string;
    method: Authentication_Method;
    inject: () => Authentication_Result;
}): Tool_Provider {
    return {
        name: options.name,
        display_name: `Stub (${options.name})`,
        image_specification: {
            base_image: 'node:22-slim',
            image_user: 'node',
            image_home: '/home/node',
            configuration_directory_name: `.${options.name}`,
            prepare_build_assets: async () => new Map(),
            get_dockerfile_lines: () => [],
            get_dockerfile_environment: () => ({}),
            get_base_preparation_lines: () => ({
                lines: ['RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*'],
                package_manager: 'apt' as const,
            }),
        },
        inject_authentication: options.inject,
        get_launch_command: () => ['/bin/sh'],
        validate_image: () => ({ valid: true, reasons: [] }),
        get_cached_version: () => null,
        get_openspec_tool_name: () => options.name,
        get_authentication_method: () => options.method,
        get_extractable_artifacts: () => [],
        inject_session_state: async () => { /* no-op */ },
    };
}

const cleanup = create_integration_cleanup_registry();

beforeAll(async () => {
    ensure_integration_test_tool_registered();
    if (!image_exists(TEST_TAG)) {
        await build_image({ tag: TEST_TAG, tools: [DEFAULT_TEST_TOOL], capabilities: [], labels: [TEST_LABEL] });
    }
}, 600_000);

afterAll(async () => {
    await cleanup.run_all();
    remove_test_images();
});

describe('7.1 — environment_variables result commits at -auth tag with label "ready"', () => {
    let source_directory: string;
    let sandbox_id: string;

    it('build commits with label ready (not authenticated)', async () => {
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        const stub = make_stub_provider({
            name: 'stub-env-71',
            method: 'environment_variables',
            inject: () => ({
                type: 'environment_variables',
                entries: [{ name: 'STUB_TOKEN', value: 'stub-value-71' }],
            }),
        });
        register_provider(stub);

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: stub.name,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, sandbox_id);

        // The committed image at the -auth tag carries the new label value.
        const auth_tag = `patchlab/tool-state-three-values-test-${stub.name}-auth:latest`;
        expect(image_exists(auth_tag)).toBe(true);
        expect(get_image_tool_state(auth_tag, stub.name)).toBe('ready');
    }, 600_000);
});

describe('7.1b — none result (env-var with vars unset) commits at no-auth tag with label "installed"', () => {
    // Automated counterpart to the original Section-10 manual check that all
    // four Tool_State label values appear correctly on real images. The
    // `'authenticated'` case is exercised end-to-end by suite 7.3 (file_copy
    // sandbox commits the `'authenticated'` label); the `'ready'` case by
    // suite 7.1 above (env-var with vars set). This block covers the third
    // non-`'absent'` label: an env-var-method provider whose inject returns
    // `{ type: 'none' }` (declared vars all unset) commits at the no-auth
    // tag with `'installed'`. Together the three suites verify every
    // `authentication_result.type → Tool_State` dispatch branch against a
    // real podman commit.
    let source_directory: string;
    let sandbox_id: string;

    it('build commits with label installed at the no-auth tag', async () => {
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        const stub = make_stub_provider({
            name: 'stub-env-71b',
            method: 'environment_variables',
            // Returning `{ type: 'none' }` simulates "declared vars all unset
            // at build time" — the same path the real env-var providers take
            // when their declared variable is missing from the host env.
            inject: () => ({ type: 'none' }),
        });
        register_provider(stub);

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: stub.name,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, sandbox_id);

        // The commit went to the no-auth tag (not the -auth tag) with label
        // 'installed'. No auth-tag image was created.
        const installed_tag = `patchlab/tool-state-three-values-test-${stub.name}:latest`;
        const auth_tag = `patchlab/tool-state-three-values-test-${stub.name}-auth:latest`;
        expect(image_exists(installed_tag)).toBe(true);
        expect(get_image_tool_state(installed_tag, stub.name)).toBe('installed');
        expect(image_exists(auth_tag)).toBe(false);
    }, 600_000);
});

describe('7.2 — legacy authenticated label on env-var-method image is read-tolerated', () => {
    let source_directory: string;
    let sandbox_id: string;

    it('cache lookup hits the legacy image AND env var is passed at create-time', async () => {
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        let inject_count = 0;
        const stub = make_stub_provider({
            name: 'stub-env-72',
            method: 'environment_variables',
            inject: () => {
                inject_count++;
                return {
                    type: 'environment_variables',
                    entries: [{ name: 'STUB_TOKEN', value: 'fresh-host-value-72' }],
                };
            },
        });
        register_provider(stub);

        // Step 1: Manually build a legacy-labeled image at the -auth tag.
        // The label is `'authenticated'` (pre-change semantics for an env-var
        // build that succeeded). This is the on-disk artifact left by an
        // older patchlab version.
        const legacy_helper_container = `patchlab-legacy-helper-${Date.now()}`;
        const legacy_auth_tag = `patchlab/tool-state-three-values-test-${stub.name}-auth:latest`;
        create_container(legacy_helper_container, TEST_TAG, {
            volume_mounts: [],
            environment_variables: {},
        });
        start_container(legacy_helper_container);
        commit_container(legacy_helper_container, legacy_auth_tag, {
            'biz.ecartz.patchlab.compatible': 'true',
            [`biz.ecartz.patchlab.tool.${stub.name}`]: 'authenticated',
            [PATCHLAB_TEST_LABEL]: 'true',
        });
        if (container_exists(legacy_helper_container)) {
            remove_container(legacy_helper_container);
        }
        // Sanity check: the legacy image really does carry the old label.
        expect(get_image_tool_state(legacy_auth_tag, stub.name)).toBe('authenticated');
        // The compatibility reader and the per-tool state reader must agree
        // on the legacy image. A regression where `is_patchlab_compatible_image`
        // rejected the legacy label scheme (e.g., expecting the per-tool
        // label exclusively) would short-circuit the cache lookup chain so
        // the env-var phase below never runs — silently breaking
        // read-tolerance for legacy on-disk images that pre-date the
        // per-tool label.
        expect(is_patchlab_compatible_image(legacy_auth_tag)).toBe(true);

        // Step 2: Create a sandbox via the normal flow. The lookup chain
        // SHOULD return the legacy-labeled image as an auth-tag cache hit
        // (read-tolerance), and the env-var phase SHOULD still invoke
        // inject_authentication (env var passed to the container at runtime).
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: stub.name,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, sandbox_id);

        // Assertion: the env-var phase did invoke inject_authentication
        // despite the legacy `'authenticated'` label on the cached image.
        // The outer get_authentication_method() === 'environment_variables'
        // gate routes correctly even when the cached label looks like
        // file_copy semantics.
        expect(inject_count).toBeGreaterThanOrEqual(1);

        // Assertion: the container received the env var.
        const env_output = exec_runtime_cli(
            ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', manifest.container_name],
            { encoding: 'utf-8' },
        );
        expect(env_output).toContain('STUB_TOKEN=fresh-host-value-72');
    }, 600_000);
});

describe('7.3 — resume always re-injects for file_copy providers regardless of image label', () => {
    let source_directory: string;
    let sandbox_id: string;

    it('inject_authentication is invoked on BOTH create AND resume (no short-circuit on resume)', async () => {
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        let inject_count = 0;
        const stub = make_stub_provider({
            name: 'stub-file-73',
            method: 'file_copy',
            inject: () => {
                inject_count++;
                return { type: 'file_copy' };
            },
        });
        register_provider(stub);

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: stub.name,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, sandbox_id);

        // Create produced one invocation (auth was injected into the new
        // image; no cache hit yet at the auth tag).
        expect(inject_count).toBe(1);

        // The build committed `'authenticated'` at the auth tag.
        const auth_tag = `patchlab/tool-state-three-values-test-${stub.name}-auth:latest`;
        expect(get_image_tool_state(auth_tag, stub.name)).toBe('authenticated');

        // Resume the sandbox. The asymmetry under test: create's file_copy
        // phase short-circuits on `'authenticated'` (so a SECOND create
        // hitting the same auth-tag cache would not re-inject), but resume
        // does NOT short-circuit — it always re-injects to pick up fresh
        // host credentials. See design.md Decision 6.
        await resume_sandbox(sandbox_id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });

        // The load-bearing assertion: resume invoked inject_authentication
        // even though the resumed image's tool_state is `'authenticated'`.
        // A short-circuit on resume would leave inject_count at 1.
        expect(inject_count).toBe(2);
    }, 600_000);
});

describe('7.4 — resume always re-injects for environment_variables providers when the auth-tag label is "ready"', () => {
    let source_directory: string;
    let sandbox_id: string;

    it('inject_authentication invoked on BOTH create AND resume, and env var is passed to resumed container', async () => {
        // Parallel to 7.3 for the env-var dispatch branch. The `'ready'`
        // label semantics (per src/podman.ts:495+): tool binary baked in,
        // auth result captured at build, but credentials NOT in image
        // bytes — the env var must be re-passed every create/resume.
        // A regression that short-circuited resume on `'ready'` (treating
        // it like `'authenticated'`) would leave the resumed container
        // without the env var, breaking the tool at runtime.
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        let inject_count = 0;
        const stub = make_stub_provider({
            name: 'stub-env-74',
            method: 'environment_variables',
            inject: () => {
                inject_count++;
                return {
                    type: 'environment_variables',
                    entries: [{ name: 'STUB_TOKEN', value: 'fresh-host-value-74' }],
                };
            },
        });
        register_provider(stub);

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: stub.name,
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, sandbox_id);

        // Create produced one invocation. Build committed `'ready'` at the
        // auth tag because env_var providers cannot bake credentials into
        // image bytes — the env var is "ready" to be passed, that's all.
        expect(inject_count).toBe(1);
        const auth_tag = `patchlab/tool-state-three-values-test-${stub.name}-auth:latest`;
        expect(get_image_tool_state(auth_tag, stub.name)).toBe('ready');

        // Resume. The asymmetry under test: env_var providers must re-pass
        // the env var because image bytes carry nothing reusable. Resume
        // SHALL invoke inject_authentication just as 7.3 covers file_copy.
        const resumed = await resume_sandbox(sandbox_id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });

        // Load-bearing assertion 1: resume invoked inject_authentication.
        expect(inject_count).toBe(2);

        // Load-bearing assertion 2: the resumed container carries the env
        // var. A bug that short-circuited inject_authentication on resume
        // (treating `'ready'` as `'authenticated'`) would leave inject_count
        // at 1 AND would not pass the env var to the resumed container.
        const env_output = exec_runtime_cli(
            ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', resumed.container_name],
            { encoding: 'utf-8' },
        );
        expect(env_output).toContain('STUB_TOKEN=fresh-host-value-74');
    }, 600_000);
});