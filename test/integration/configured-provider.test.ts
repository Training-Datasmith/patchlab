/**
 * Podman-real integration test for `Configured_Tool_Provider` dispatch.
 *
 * Honors the forward-looking note in archived task 6.13 of
 * `2026-05-13-configured-provider-user-global-runtime`:
 *
 *   "the sibling change configured-provider-per-source-and-trust will add the
 *    podman-real case once per-source trust gating is in place"
 *
 * The image-build and container-run pipeline doesn't differ by registration
 * scope (user-global vs per-source) — both go through the same
 * `Configured_Tool_Provider.image_specification`, the same `build_image`
 * path, the same hash-bearing tag scheme. So ONE end-to-end test that covers
 * the dispatch from "configured provider in the registry" through "real
 * container ran the launch_command" is sufficient to honor the promise. The
 * test exercises a per-source registration here because that's the scope this
 * change ships.
 *
 * Unit-level dispatch coverage (no real podman) lives in
 * `test/unit/per-source-dispatch.test.ts` and the W3/W4 tests in
 * `test/unit/effective-image.test.ts`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox_from_directory } from '../test_helpers.js';
import {
    PATCHLAB_TEST_LABEL,
    build_image,
    remove_test_images,
} from '../../src/images.js';
import {
    create_container,
    start_container,
    remove_container,
    exec_container,
    container_exists,
} from '../../src/container_runtime.js';
import { exec_runtime_cli, inspect_image_labels } from '../helpers/exec_runtime_cli.js';
import {
    register_per_source_manifests,
} from '../../src/tools/index.js';
import {
    _drop_per_source_registrations,
    get_provider,
} from '../../src/tools/provider.js';
import {
    create_integration_cleanup_registry,
    register_destroy_sandbox,
} from '../helpers/integration_cleanup.js';
const TEST_CONTAINER = 'patchlab-configured-provider-integration';

const LAUNCH_TOKEN = 'patchlab-configured-provider-launched-ok';

// Minimal YAML for a per-source configured provider. method:none keeps the
// build cheap (no credential copy, no env-var injection). Launch command is a
// simple echo so the test can `podman logs` for the token and confirm the
// container exec'd what the provider asked for.
// image_user: root sidesteps the useradd step (Configured_Tool_Provider's
// base-preparation builder special-cases root) — useful here because
// node:24-alpine pre-allocates uid 1000 to its `node` user, which would clash
// with patchlab's default non-root uid.
const PER_SOURCE_MANIFEST_YAML = `name: integration-tool
display_name: Integration Tool
image_user: root
base_image: docker.io/library/node:24-alpine
base_family: alpine
package_manager: apk
authentication:
  method: none
launch_command:
  - sh
  - -c
  - echo ${LAUNCH_TOKEN}
`;

const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;
const cleanup = create_integration_cleanup_registry();

afterAll(async () => {
    await cleanup.run_all();
    remove_test_images();
    _drop_per_source_registrations();
});

describe('configured-provider dispatch via real podman', () => {
    let source_path: string;
    let configured_tag: string;

    beforeAll(() => {
        source_path = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-configured-integration-')));
        fs.mkdirSync(path.join(source_path, '.patchlab', 'tools'), { recursive: true });
        fs.writeFileSync(
            path.join(source_path, '.patchlab', 'tools', 'integration-tool.yaml'),
            PER_SOURCE_MANIFEST_YAML,
        );
        // Initialize as a git repo so `create_sandbox_from_directory` can
        // walk the Phase-1 preflight + Phase-2 baseline-commit path. The
        // existing test above only uses `build_image` + `create_container`
        // directly, so it doesn't need a repo — but the end-to-end test
        // below does.
        execFileSync('git', ['init', '-q'], { cwd: source_path, stdio: 'pipe' });
        execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'add', '-A'], { cwd: source_path, stdio: 'pipe' });
        execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-q', '-m', 'initial'], { cwd: source_path, stdio: 'pipe' });
        cleanup.register(() => {
            try {
                fs.rmSync(source_path, { recursive: true, force: true });
            } catch (_ignored) {
                // ignore
            }
        });
    });

    it('registers a per-source manifest, builds a real image, runs the launch_command in a container', async () => {
        // Registration — read the manifest, register the synthesized
        // Configured_Tool_Provider into the process-scoped registry.
        const result = register_per_source_manifests([source_path]);
        expect(result.errors).toHaveLength(0);
        expect(result.registered_manifests).toHaveLength(1);

        // Sanity: get_provider resolves the configured name. This is the
        // dispatch path `patchlab create --tool integration-tool` would walk.
        const provider = get_provider('integration-tool');
        expect(provider.name).toBe('integration-tool');

        // Image build — exercises Configured_Tool_Provider.image_specification
        // through build_image's real podman path. build_image produces the
        // base-tier image; the tool-specific hash-bearing tag is applied
        // later by set_up_image_tier inside create_sandbox. For this smoke
        // test we just need to confirm the base build accepts the configured
        // provider's specification and produces a runnable image.
        configured_tag = await build_image({
            tools: ['integration-tool'],
            labels: [TEST_LABEL],
        });
        expect(configured_tag).toBeTruthy();
        cleanup.register(() => {
            try {
                exec_runtime_cli(['rmi', '-f', configured_tag], { stdio: 'pipe' });
            } catch (_ignored) {
                // ignore
            }
        });

        // Lock the per-source label round-trip: the manifest's tool name
        // MUST surface on the built image's `biz.ecartz.patchlab.tools`
        // label. A regression where Configured_Tool_Provider.image_specification
        // returned an empty/wrong label set (or the build path silently
        // stripped it) would only manifest when a downstream cache lookup
        // missed — which the smoke test below does NOT exercise, since it
        // creates a fresh container against the just-built tag every time.
        const labels = inspect_image_labels(configured_tag);
        // The patchlab-compatible label is universal across patchlab images.
        expect(labels['biz.ecartz.patchlab.compatible']).toBe('true');
        // The tools label is a comma-separated list (or a single name); the
        // configured provider's name MUST appear in it.
        expect(labels['biz.ecartz.patchlab.tools']).toBeDefined();
        expect(labels['biz.ecartz.patchlab.tools'].split(',').map((s) => s.trim()))
            .toContain('integration-tool');

        // Container lifecycle — create, start, exec the provider's launch
        // command, verify the token appears in the container's stdout. This
        // is what `patchlab create` does after building the image.
        create_container(TEST_CONTAINER, configured_tag);
        cleanup.register(() => {
            try {
                remove_container(TEST_CONTAINER);
            } catch (_ignored) {
                // ignore
            }
        });
        start_container(TEST_CONTAINER);
        expect(container_exists(TEST_CONTAINER)).toBe(true);

        const launch_command = provider.get_launch_command();
        const exec_output = exec_container(TEST_CONTAINER, launch_command);
        expect(exec_output).toContain(LAUNCH_TOKEN);
    }, 600_000);

    it('end-to-end via create_sandbox: configured tool provisions a real sandbox whose container runs the provider launch_command', async () => {
        // The previous test calls `create_container` directly with the
        // configured tag, bypassing `create_sandbox`. That smoke test
        // proves the build pipeline accepts the configured spec, but it
        // doesn't prove that `create_sandbox`'s tool-dispatch path
        // (Phase-2 mutations → image resolution → container provision)
        // actually wires the configured provider through end-to-end. A
        // regression where `create_sandbox` silently substituted a default
        // tool, ignored the configured image_specification, or provisioned
        // the container with the wrong workdir would not surface in the
        // direct-build test above.
        const manifest = await create_sandbox_from_directory(source_path, {
            tool: 'integration-tool',
            no_install: true,
            allow_untrusted_manifests: true,
        });
        register_destroy_sandbox(cleanup, manifest.id);

        // The dispatched provider's launch command produces the token
        // inside the create_sandbox-provisioned container.
        const provider = get_provider('integration-tool');
        const exec_output = exec_container(manifest.container_name, provider.get_launch_command());
        expect(exec_output).toContain(LAUNCH_TOKEN);
    }, 600_000);
});
