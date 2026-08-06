import { describe, it, expect } from 'vitest';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../src/tools/types.js';
import {
    register_provider,
    register_with_source,
    get_provider,
    list_providers,
    list_registrations,
    get_provider_source,
} from '../../src/tools/provider.js';

function create_stub_provider(name: string): Tool_Provider {
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
        get_launch_command() { return ['stub']; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return name; },
        get_authentication_method(): Authentication_Method { return 'file_copy'; },
        get_extractable_artifacts() { return []; },
        async inject_session_state() { /* no-op stub */ },
    };
}

describe('tool registry', () => {
    describe('register_provider', () => {
        it('registers a provider that can be retrieved by name', () => {
            const provider = create_stub_provider('test-tool');
            register_provider(provider);

            expect(get_provider('test-tool')).toBe(provider);
        });

        it('rejects provider names with invalid characters', () => {
            const provider = create_stub_provider('Test.Tool');
            expect(() => register_provider(provider)).toThrow();
        });

        it('rejects provider names containing dots', () => {
            const provider = create_stub_provider('foo.bar');
            expect(() => register_provider(provider)).toThrow();
        });

        it('accepts provider names with lowercase alphanumeric and hyphens', () => {
            const provider = create_stub_provider('my-tool-2');
            expect(() => register_provider(provider)).not.toThrow();
        });
    });

    describe('get_provider', () => {
        it('returns the registered provider', () => {
            const provider = create_stub_provider('lookup-test');
            register_provider(provider);

            const result = get_provider('lookup-test');
            expect(result.name).toBe('lookup-test');
            expect(result.display_name).toBe('Stub lookup-test');
        });

        it('throws for unknown provider names', () => {
            expect(() => get_provider('nonexistent')).toThrow(/nonexistent/);
        });

        it('includes available tool names in the error message', () => {
            register_provider(create_stub_provider('available-a'));
            register_provider(create_stub_provider('available-b'));

            try {
                get_provider('missing');
                expect.unreachable('should have thrown');
            } catch (error) {
                const message = (error as Error).message;
                expect(message).toContain('available-a');
                expect(message).toContain('available-b');
            }
        });
    });

    describe('list_providers', () => {
        it('returns names of all registered providers', () => {
            register_provider(create_stub_provider('list-a'));
            register_provider(create_stub_provider('list-b'));

            const names = list_providers();
            expect(names).toContain('list-a');
            expect(names).toContain('list-b');
        });

        it('returns an array of strings', () => {
            const names = list_providers();
            expect(Array.isArray(names)).toBe(true);
            for (const name of names) {
                expect(typeof name).toBe('string');
            }
        });
    });
});

describe('Tool_Provider interface', () => {
    it('stub provider satisfies the interface contract', () => {
        const provider = create_stub_provider('interface-test');

        expect(typeof provider.name).toBe('string');
        expect(typeof provider.display_name).toBe('string');
        expect(typeof provider.image_specification.image_user).toBe('string');
        expect(typeof provider.image_specification.image_home).toBe('string');
        expect(typeof provider.image_specification.base_image).toBe('string');
        expect(provider.image_specification.prepare_build_assets()).resolves.toBeInstanceOf(Map);
        expect(Array.isArray(provider.image_specification.get_dockerfile_lines([]))).toBe(true);
        expect(typeof provider.image_specification.get_dockerfile_environment()).toBe('object');
        expect(provider.image_specification.get_base_preparation_lines(1000)).toHaveProperty('lines');
        expect(provider.inject_authentication({ sandbox_id: 'test' })).toHaveProperty('type');
        expect(Array.isArray(provider.get_launch_command())).toBe(true);
        expect(provider.validate_image('test:latest')).toHaveProperty('valid');
        expect(provider.validate_image('test:latest')).toHaveProperty('reasons');
        expect(typeof provider.get_openspec_tool_name()).toBe('string');
        expect(['file_copy', 'environment_variables', 'none']).toContain(provider.get_authentication_method());
    });

    it('image_specification.base_image is mandatory and non-empty', () => {
        const provider = create_stub_provider('base-image-required');
        expect(provider.image_specification.base_image).toBeTruthy();
        expect(provider.image_specification.base_image.length).toBeGreaterThan(0);
    });

    it('image_specification.base_image can be overridden per-provider', () => {
        const stub = create_stub_provider('with-different-base');
        const provider: Tool_Provider = {
            ...stub,
            image_specification: {
                ...stub.image_specification,
                base_image: 'us-docker.pkg.dev/gemini-code-dev/gemini-cli/sandbox:0.38.2',
            },
        };
        expect(provider.image_specification.base_image).toBe(
            'us-docker.pkg.dev/gemini-code-dev/gemini-cli/sandbox:0.38.2',
        );
    });
});

describe('Authentication_Result type', () => {
    it('supports none result', () => {
        const result: Authentication_Result = { type: 'none' };
        expect(result.type).toBe('none');
    });

    it('supports file_copy result', () => {
        const result: Authentication_Result = { type: 'file_copy' };
        expect(result.type).toBe('file_copy');
    });

    it('supports environment_variables result with one entry', () => {
        const result: Authentication_Result = { type: 'environment_variables', entries: [{ name: 'GEMINI_API_KEY', value: 'test-key' }] };
        expect(result.type).toBe('environment_variables');
        if (result.type === 'environment_variables') {
            expect(result.entries).toHaveLength(1);
            expect(result.entries[0].name).toBe('GEMINI_API_KEY');
            expect(result.entries[0].value).toBe('test-key');
        }
    });

    it('supports environment_variables result with multiple entries', () => {
        const result: Authentication_Result = {
            type: 'environment_variables',
            entries: [
                { name: 'GITHUB_TOKEN', value: 'gh-token' },
                { name: 'OPENAI_API_KEY', value: 'oai-key' },
            ],
        };
        expect(result.type).toBe('environment_variables');
        if (result.type === 'environment_variables') {
            expect(result.entries.map((entry) => entry.name)).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
        }
    });
});

describe('register_with_source and source metadata (Section 3)', () => {
    it('records source: built-in for register_provider', () => {
        const provider = create_stub_provider('source-builtin-test');
        register_provider(provider);
        expect(get_provider_source('source-builtin-test')).toEqual({ kind: 'built-in' });
    });

    it('records source: user-global with manifest_path for register_with_source', () => {
        const provider = create_stub_provider('source-user-global-test');
        register_with_source(provider, { kind: 'user-global', manifest_path: '/manifests/foo.yaml' });
        expect(get_provider_source('source-user-global-test')).toEqual({
            kind: 'user-global',
            manifest_path: '/manifests/foo.yaml',
        });
    });

    it('register_with_source rejects a malformed provider name (defends against bypassed manifest validation)', () => {
        // Manifest parsing rejects most malformed names earlier, so this
        // throw guards an internal invariant: any path that constructs a
        // `Tool_Provider` and calls `register_with_source` directly must
        // satisfy the same name shape `register_provider` enforces.
        // Symmetric coverage to `register_provider` rejecting invalid names.
        const provider = create_stub_provider('Bad.Name');
        expect(() =>
            register_with_source(provider, { kind: 'user-global', manifest_path: '/manifests/bad.yaml' }),
        ).toThrow(/Invalid provider name/);
    });

    it('list_registrations returns all providers with their source metadata', () => {
        const a = create_stub_provider('reg-list-a');
        const b = create_stub_provider('reg-list-b');
        register_provider(a);
        register_with_source(b, { kind: 'user-global', manifest_path: '/manifests/b.yaml' });

        const registrations = list_registrations();
        const a_entry = registrations.find((entry) => entry.name === 'reg-list-a');
        const b_entry = registrations.find((entry) => entry.name === 'reg-list-b');
        expect(a_entry?.source).toEqual({ kind: 'built-in' });
        expect(b_entry?.source).toEqual({ kind: 'user-global', manifest_path: '/manifests/b.yaml' });
    });

    it('get_provider_source returns null for an unregistered name', () => {
        expect(get_provider_source('never-registered-xyz')).toBeNull();
    });

    it('unknown tool error groups available tools by source (Section 3)', () => {
        const built_in = create_stub_provider('err-builtin-a');
        const user_global = create_stub_provider('err-userglobal-b');
        register_provider(built_in);
        register_with_source(user_global, { kind: 'user-global', manifest_path: '/manifests/b.yaml' });

        let error_message = '';
        try {
            get_provider('nonexistent-xyz');
        } catch (error) {
            error_message = error instanceof Error ? error.message : String(error);
        }

        expect(error_message).toContain("Unknown tool 'nonexistent-xyz'");
        expect(error_message).toContain('built-in:');
        expect(error_message).toContain('err-builtin-a');
        expect(error_message).toContain('user-global: /manifests/b.yaml');
        expect(error_message).toContain('err-userglobal-b');
    });
});
