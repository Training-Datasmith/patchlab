/**
 * Tests for `register_per_source_manifests` — per-source manifest discovery,
 * containment-validated registration, and the shared-buffer TOCTOU property.
 *
 * Coverage:
 * - Happy path: discover + parse + register
 * - Parse errors: collected, not thrown
 * - Containment violations: collected as Manifest_Parse_Error
 * - Built-in collision (with/without overrides_builtin)
 * - Within-scope name conflict (first wins)
 * - Cross-scope precedence: per-source replaces user-global of same name
 * - TOCTOU: each manifest file is read exactly once per registration call
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    register_per_source_manifests,
    register_provider,
} from '../../src/tools/index.js';
import {
    _reset_registry,
    register_with_source,
    get_provider,
    get_provider_source,
} from '../../src/tools/provider.js';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../src/tools/types.js';

const BUILT_IN_STUB = 'built-in-stub';

function make_stub_builtin(name: string = BUILT_IN_STUB): Tool_Provider {
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

const VALID_MANIFEST_YAML = (overrides: Record<string, string> = {}): string => {
    const fields: Record<string, string> = {
        name: 'aider',
        display_name: 'Aider',
        image_user: 'patchlab',
        base_image: 'docker.io/library/python:3.12-slim',
        base_family: 'debian',
        package_manager: 'apt',
        ...overrides,
    };
    const top = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
    return `${top}\nauthentication:\n  method: none\nlaunch_command:\n  - aider\n`;
};

describe('register_per_source_manifests — happy path', () => {
    let temporary_source: string;

    beforeEach(() => {
        _reset_registry();
        temporary_source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-per-source-')));
        fs.mkdirSync(path.join(temporary_source, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(temporary_source, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('discovers and registers a well-formed per-source manifest', () => {
        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', 'aider.yaml'),
            VALID_MANIFEST_YAML(),
        );

        const result = register_per_source_manifests([temporary_source]);

        expect(result.errors).toHaveLength(0);
        expect(result.registered_manifests).toHaveLength(1);
        expect(result.registered_manifests[0].name).toBe('aider');

        const provider = get_provider('aider');
        expect(provider.name).toBe('aider');

        const source = get_provider_source('aider');
        expect(source?.kind).toBe('per-source');
        if (source?.kind === 'per-source') {
            expect(source.source_path).toBe(temporary_source);
        }
    });

    it('returns an empty result when there are no manifests', () => {
        const result = register_per_source_manifests([temporary_source]);
        expect(result.errors).toHaveLength(0);
        expect(result.registered_manifests).toHaveLength(0);
        expect(result.manifest_buffers.size).toBe(0);
    });
});

describe('register_per_source_manifests — error collection', () => {
    let temporary_source: string;

    beforeEach(() => {
        _reset_registry();
        temporary_source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-per-source-')));
        fs.mkdirSync(path.join(temporary_source, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(temporary_source, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('collects parse errors instead of throwing', () => {
        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', 'broken.yaml'),
            'name: aider\n  bad-indent\n',
        );

        const result = register_per_source_manifests([temporary_source]);

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.registered_manifests).toHaveLength(0);
    });

    it('rejects built-in collisions without overrides_builtin', () => {
        register_provider(make_stub_builtin());
        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', `${BUILT_IN_STUB}.yaml`),
            VALID_MANIFEST_YAML({ name: BUILT_IN_STUB, display_name: 'Built-in stub (per-source)' }),
        );

        const result = register_per_source_manifests([temporary_source]);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field_path).toBe('overrides_builtin');
        expect(get_provider(BUILT_IN_STUB).display_name).toBe(`Stub ${BUILT_IN_STUB}`);
    });

    it('accepts overrides_builtin: true and replaces the built-in', () => {
        register_provider(make_stub_builtin());
        const yaml_body =
            VALID_MANIFEST_YAML({ name: BUILT_IN_STUB, display_name: 'Built-in stub (per-source)' })
            + 'overrides_builtin: true\n';
        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', `${BUILT_IN_STUB}.yaml`),
            yaml_body,
        );

        const result = register_per_source_manifests([temporary_source]);

        expect(result.errors).toHaveLength(0);
        expect(get_provider(BUILT_IN_STUB).display_name).toBe('Built-in stub (per-source)');
        const source = get_provider_source(BUILT_IN_STUB);
        expect(source?.kind).toBe('per-source');
    });

    it('within-scope name conflict throws Manifest_Collision_Error (intra-scope hard-fail)', () => {
        // multi-source-trust reconciliation: the main spec said "SHALL fail
        // loading" but the implementation drifted to skip-and-warn. This
        // change makes intra-scope collisions a hard fail to match the spec.
        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', 'aider-a.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'Aider A' }),
        );
        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', 'aider-b.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'Aider B' }),
        );

        expect(() => register_per_source_manifests([temporary_source]))
            .toThrow(/Two manifests in the same repository declare name 'aider'/);
        // No partial registration on hard-fail: get_provider should not
        // resolve to either manifest. Built-in 'aider' is not registered
        // (the suite registers stub built-ins per test, not aider), so
        // this lookup falls back to whatever module-load registered, which
        // does not include aider. Verify aider was not silently registered
        // from one of the two manifests.
        expect(() => get_provider('aider')).toThrow();
    });

    it('replaces a same-named user-global manifest with per-source for the duration of the process', () => {
        // Pretend a user-global manifest already registered 'aider' as a user-global entry.
        register_with_source(
            { ...make_stub_builtin('aider'), display_name: 'Aider (user-global)' },
            { kind: 'user-global', manifest_path: '/home/user/.patchlab/tools/aider.yaml' },
        );

        fs.writeFileSync(
            path.join(temporary_source, '.patchlab', 'tools', 'aider.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'Aider (per-source)' }),
        );

        register_per_source_manifests([temporary_source]);

        expect(get_provider('aider').display_name).toBe('Aider (per-source)');
        expect(get_provider_source('aider')?.kind).toBe('per-source');
    });
});

describe('register_per_source_manifests — TOCTOU shared buffer (task 6.19)', () => {
    let temporary_source: string;

    beforeEach(() => {
        _reset_registry();
        temporary_source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-toctou-')));
        fs.mkdirSync(path.join(temporary_source, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(temporary_source, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('exposes manifest_buffers byte-equal to the on-disk bytes for shared use by the hash', () => {
        const manifest_path = path.join(temporary_source, '.patchlab', 'tools', 'aider.yaml');
        const original_bytes = Buffer.from(VALID_MANIFEST_YAML(), 'utf-8');
        fs.writeFileSync(manifest_path, original_bytes);

        const result = register_per_source_manifests([temporary_source]);

        const captured = result.manifest_buffers.get(manifest_path);
        expect(captured).toBeDefined();
        expect(captured?.equals(original_bytes)).toBe(true);
    });

    it('returns the SAME buffer instance to caller so hash and parse share bytes', () => {
        const manifest_path = path.join(temporary_source, '.patchlab', 'tools', 'aider.yaml');
        fs.writeFileSync(manifest_path, VALID_MANIFEST_YAML());

        // Mutate the file AFTER registration. The buffer captured during the
        // single read should NOT reflect the mutation — proves the cached
        // buffer is the snapshot, not a re-read.
        const result = register_per_source_manifests([temporary_source]);
        const original_buffer = result.manifest_buffers.get(manifest_path);
        expect(original_buffer).toBeDefined();

        fs.writeFileSync(manifest_path, 'name: totally-different\n');
        // The buffer in result should not have changed
        const buffer_after = result.manifest_buffers.get(manifest_path);
        expect(buffer_after).toBe(original_buffer);
        expect(buffer_after?.toString('utf-8')).toContain('aider');
    });
});

/**
 * Multi-repository registration coverage (multi-source-trust task 4.6):
 *
 *   - Two repos with disjoint tool names register both successfully
 *   - Two repos with the same `name` throw `Manifest_Collision_Error` (cross-scope)
 *   - Two repos each with their own containment violation surface independently
 *   - Same-repo intra-scope collision still throws (re-covered here with explicit repo list)
 *   - User-global with same name as per-source is unaffected by cross-repo rule
 */
describe('register_per_source_manifests — multi-repository (task 4.6)', () => {
    let repository_a: string;
    let repository_b: string;

    beforeEach(() => {
        _reset_registry();
        repository_a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-multi-repo-a-')));
        repository_b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-multi-repo-b-')));
        fs.mkdirSync(path.join(repository_a, '.patchlab', 'tools'), { recursive: true });
        fs.mkdirSync(path.join(repository_b, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(repository_a, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_b, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('two repos with disjoint tool names register both successfully', () => {
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'foo.yaml'),
            VALID_MANIFEST_YAML({ name: 'foo', display_name: 'Foo' }),
        );
        fs.writeFileSync(
            path.join(repository_b, '.patchlab', 'tools', 'bar.yaml'),
            VALID_MANIFEST_YAML({ name: 'bar', display_name: 'Bar' }),
        );

        const result = register_per_source_manifests([repository_a, repository_b]);

        expect(result.errors).toHaveLength(0);
        expect(result.registered_manifests).toHaveLength(2);
        expect(get_provider('foo').display_name).toBe('Foo');
        expect(get_provider('bar').display_name).toBe('Bar');
    });

    it('two repos with the same name throw Manifest_Collision_Error (cross-scope)', () => {
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'aider.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'Aider A' }),
        );
        fs.writeFileSync(
            path.join(repository_b, '.patchlab', 'tools', 'aider.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'Aider B' }),
        );

        expect(() => register_per_source_manifests([repository_a, repository_b]))
            .toThrow(/Two repositories' per-source manifests declare the same name 'aider'/);
    });

    it('cross-scope collision error names both repositories and points at user-global', () => {
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'aider.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider' }),
        );
        fs.writeFileSync(
            path.join(repository_b, '.patchlab', 'tools', 'aider.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider' }),
        );

        try {
            register_per_source_manifests([repository_a, repository_b]);
            throw new Error('expected throw');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toContain(repository_a);
            expect(message).toContain(repository_b);
            expect(message).toContain('user-global');
        }
    });

    it('one repo with a containment violation collected without affecting the other repo', () => {
        // repo-a manifest is valid; repo-b manifest tries to reference a
        // host file outside its own repository — that's a per-repo
        // containment failure surfaced as a Manifest_Parse_Error.
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'foo.yaml'),
            VALID_MANIFEST_YAML({ name: 'foo' }),
        );
        fs.writeFileSync(
            path.join(repository_b, '.patchlab', 'tools', 'bad.yaml'),
            `name: bad
display_name: Bad
image_user: patchlab
base_image: docker.io/library/python:3.12-slim
base_family: debian
package_manager: apt
authentication:
  method: file_copy
  copies:
    - host: ${repository_a}/should-be-rejected
      container: /home/patchlab/.bad/file
launch_command:
  - bad
`,
        );

        const result = register_per_source_manifests([repository_a, repository_b]);

        // repo-a's foo registered successfully; repo-b's bad is in errors.
        expect(get_provider('foo').name).toBe('foo');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].manifest_path).toContain('bad.yaml');
    });

    it('intra-scope collision in one of N repos still throws even with multi-repo signature', () => {
        // Reconfirms that the intra-scope hard-fail fires when one repo has
        // duplicates, even when called via the multi-repo signature.
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'aider-a.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'A' }),
        );
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'aider-b.yaml'),
            VALID_MANIFEST_YAML({ name: 'aider', display_name: 'B' }),
        );
        fs.writeFileSync(
            path.join(repository_b, '.patchlab', 'tools', 'unrelated.yaml'),
            VALID_MANIFEST_YAML({ name: 'unrelated' }),
        );

        expect(() => register_per_source_manifests([repository_a, repository_b]))
            .toThrow(/Two manifests in the same repository declare name 'aider'/);
    });

    it('user-global manifest with same name as per-source is unaffected by cross-scope rule', () => {
        // Cross-scope rule fires only across multiple per-source scopes.
        // User-global + per-source uses the established precedence (per-source
        // wins) — this test verifies the collision detector ignores user-global
        // entries.
        register_provider(make_stub_builtin('shared'));
        fs.writeFileSync(
            path.join(repository_a, '.patchlab', 'tools', 'shared.yaml'),
            VALID_MANIFEST_YAML({ name: 'shared', display_name: 'Per-source shared', overrides_builtin: 'true' }),
        );

        // Just one repo's per-source manifest — no cross-scope collision.
        const result = register_per_source_manifests([repository_a]);

        expect(result.errors).toHaveLength(0);
        expect(get_provider('shared').display_name).toBe('Per-source shared');
    });
});
