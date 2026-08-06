/**
 * End-to-end per-source dispatch coverage (integration-equivalent, no real
 * podman). Walks the full wiring path that `patchlab create --tool <name>`
 * exercises when `<name>` resolves to a per-source manifest:
 *
 *   1. `register_per_source_manifests([source_path])` discovers + parses +
 *      registers
 *   2. `verify_per_source_trust(...)` prompts (TTY-stubbed accept) and writes
 *      the marker at `~/.patchlab/trusted-sources/<key>.json` (via
 *      `PATCHLAB_HOME` override)
 *   3. `get_provider('foo')` returns the `Configured_Tool_Provider`
 *   4. Provider's `image_specification` and `get_launch_command()` are
 *      callable — what `patchlab create` would dispatch into next
 *   5. A second pass with the marker in place short-circuits the prompt
 *
 * This is the analogue of the W3/W4 dispatch tests that locked end-to-end
 * coverage for `configured-provider-user-global-runtime`. A podman-real
 * integration test is intentionally out of scope here because patchlab's
 * integration suite shares a single podman runtime — the unit-level wiring
 * lock is what matters for spec coverage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    register_per_source_manifests,
} from '../../../../src/tools/index.js';
import {
    _reset_registry,
    register_provider,
    get_provider,
    get_provider_source,
} from '../../../../src/tools/provider.js';
import { compute_trusted_manifests_hash } from '../../../../src/tools/configured_provider/index.js';
import {
    verify_per_source_trust,
    is_per_source_unconfirmed,
} from '../../../../src/tools/configured_provider/trust_verification.js';
import { read_trust_marker } from '../../../../src/tools/configured_provider/trust_marker.js';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../../../src/tools/types.js';
import type { Prompter } from '../../../../src/prompts.js';

// Inline Prompter for the migration from the old `is_tty`/`confirm_prompt`
// pair to the unified `prompter` field. `choose` is unused by trust
// verification — throw if it's ever reached to catch a spec drift.
function inline_prompter(
    confirm_function: (message: string) => Promise<boolean>,
): Prompter {
    return {
        confirm: confirm_function,
        choose: async () => { throw new Error('inline_prompter.choose unused in trust tests'); },
    };
}

function make_stub_builtin(name: string): Tool_Provider {
    return {
        name,
        display_name: `Stub ${name}`,
        image_specification: {
            base_image: 'docker.io/library/node:24-bookworm-slim',
            image_user: 'patchlab',
            image_home: '/home/patchlab',
            configuration_directory_name: '.stub',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
        },
        inject_authentication(): Authentication_Result { return { type: 'none' }; },
        get_launch_command() { return [name]; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return name; },
        get_authentication_method(): Authentication_Method { return 'none'; },
        get_extractable_artifacts() { return []; },
        async inject_session_state() { /* no-op */ },
    };
}

const FOO_MANIFEST_YAML = `name: foo
display_name: Foo
image_user: patchlab
base_image: docker.io/library/python:3.12-slim
base_family: debian
package_manager: apt
authentication:
  method: none
launch_command:
  - foo
  - --no-color
`;

describe('end-to-end per-source dispatch (task 6.14, integration-equivalent)', () => {
    let patchlab_home: string;
    let source_path: string;
    let original_patchlab_home: string | undefined;

    beforeEach(() => {
        _reset_registry();
        register_provider(make_stub_builtin('gemini-cli-oauth'));
        register_provider(make_stub_builtin('gemini-cli-oauth'));

        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-dispatch-home-'));
        original_patchlab_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;

        source_path = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-dispatch-source-')));
        fs.mkdirSync(path.join(source_path, '.patchlab', 'tools'), { recursive: true });
        fs.writeFileSync(
            path.join(source_path, '.patchlab', 'tools', 'foo.yaml'),
            FOO_MANIFEST_YAML,
        );
    });

    afterEach(() => {
        if (original_patchlab_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_patchlab_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(source_path, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('register → verify (TTY accept, marker written) → get_provider returns the configured provider', async () => {
        // Step 1: registration
        const registration_result = register_per_source_manifests([source_path]);
        expect(registration_result.errors).toHaveLength(0);
        expect(registration_result.registered_manifests).toHaveLength(1);
        expect(registration_result.registered_manifests[0].name).toBe('foo');

        // Step 2: trust verification with TTY accept stub
        await verify_per_source_trust(
            source_path,
            registration_result.manifest_buffers,
            registration_result.registered_manifests,
            registration_result.errors,
            {
                prompter: inline_prompter(async () => true),
                output_warn: () => { /* silent for the test */ },
            },
        );

        // Marker now persists the trust decision
        const expected_hash = compute_trusted_manifests_hash(registration_result.manifest_buffers);
        expect(read_trust_marker(source_path)).toBe(expected_hash);
        expect(is_per_source_unconfirmed(source_path, registration_result.manifest_buffers)).toBe(false);

        // Step 3: dispatch via get_provider — this is what `--tool foo` resolves through
        const provider = get_provider('foo');
        expect(provider.name).toBe('foo');
        expect(provider.display_name).toBe('Foo');

        // Step 4: provider exposes the wiring the rest of `create` walks
        expect(provider.image_specification.image_user).toBe('patchlab');
        expect(provider.image_specification.base_image).toBe('docker.io/library/python:3.12-slim');
        expect(provider.get_launch_command()).toEqual(['foo', '--no-color']);

        // Source metadata flows through so list-tools and unknown-tool errors
        // can group output by source
        expect(get_provider_source('foo')).toEqual({
            kind: 'per-source',
            manifest_path: path.join(source_path, '.patchlab', 'tools', 'foo.yaml'),
            source_path,
        });
    });

    it('a second register+verify with the marker present short-circuits the prompt', async () => {
        // First pass: register, accept, marker written
        const first_pass = register_per_source_manifests([source_path]);
        await verify_per_source_trust(
            source_path,
            first_pass.manifest_buffers,
            first_pass.registered_manifests,
            first_pass.errors,
            { prompter: inline_prompter(async () => true), output_warn: () => { /* silent */ } },
        );

        // Second pass simulates a subsequent `patchlab create` or `resume` against
        // the same source. Re-register and re-verify; the prompt SHOULD NOT fire.
        _reset_registry();
        register_provider(make_stub_builtin('gemini-cli-oauth'));
        register_provider(make_stub_builtin('gemini-cli-oauth'));
        const second_pass = register_per_source_manifests([source_path]);

        let prompt_called = false;
        await verify_per_source_trust(
            source_path,
            second_pass.manifest_buffers,
            second_pass.registered_manifests,
            second_pass.errors,
            {
                prompter: inline_prompter(async () => { prompt_called = true; return true; }),
                output_warn: () => { /* silent */ },
            },
        );

        expect(prompt_called).toBe(false);
        // Provider still resolves through after the silent re-pass
        expect(get_provider('foo').name).toBe('foo');
    });

    it('editing the per-source manifest invalidates the marker and re-prompts on next dispatch (task 6.15)', async () => {
        // First pass — accept, marker captures the original byte hash
        const first_pass = register_per_source_manifests([source_path]);
        await verify_per_source_trust(
            source_path,
            first_pass.manifest_buffers,
            first_pass.registered_manifests,
            first_pass.errors,
            { prompter: inline_prompter(async () => true), output_warn: () => { /* silent */ } },
        );
        const marker_after_first = read_trust_marker(source_path);
        expect(marker_after_first).not.toBeNull();

        // Edit the manifest — change the launch_command to something else
        fs.writeFileSync(
            path.join(source_path, '.patchlab', 'tools', 'foo.yaml'),
            FOO_MANIFEST_YAML.replace('- --no-color', '- --version'),
        );

        // Second pass picks up the new bytes; marker hash no longer matches
        _reset_registry();
        register_provider(make_stub_builtin('gemini-cli-oauth'));
        register_provider(make_stub_builtin('gemini-cli-oauth'));
        const second_pass = register_per_source_manifests([source_path]);

        // The new manifest is no longer trusted
        expect(is_per_source_unconfirmed(source_path, second_pass.manifest_buffers)).toBe(true);

        let prompt_called = false;
        await verify_per_source_trust(
            source_path,
            second_pass.manifest_buffers,
            second_pass.registered_manifests,
            second_pass.errors,
            {
                prompter: inline_prompter(async () => { prompt_called = true; return true; }),
                output_warn: () => { /* silent */ },
            },
        );
        expect(prompt_called).toBe(true);

        // Marker now reflects the new hash
        const marker_after_second = read_trust_marker(source_path);
        expect(marker_after_second).not.toBe(marker_after_first);
    });
});
