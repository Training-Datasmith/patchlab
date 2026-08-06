/**
 * Tests for `register_user_global_providers` — the registry-integration path
 * that discovers user-global manifests, synthesizes `Configured_Tool_Provider`
 * instances, and adds them to the registry alongside built-ins.
 *
 * The function in `src/tools/index.ts` runs at module load as a side effect;
 * these tests reset the registry between cases and stub the discovery helpers
 * so each case sees a controlled manifest set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsoleLogger, set_logger } from '../../src/logger.js';
import { RecordingLogger } from '../helpers/recording_logger.js';

vi.mock('../../src/tools/configured_provider/index.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/tools/configured_provider/index.js')>();
    return {
        ...original,
        discover_user_global_manifest_paths: vi.fn<() => string[]>(() => []),
        read_and_parse_manifest: vi.fn(),
    };
});

import {
    discover_user_global_manifest_paths,
    read_and_parse_manifest,
    type Configured_Tool_Provider_Manifest,
} from '../../src/tools/configured_provider/index.js';
import { register_user_global_providers } from '../../src/tools/index.js';
import {
    _reset_registry,
    register_provider,
    get_provider,
    get_provider_source,
} from '../../src/tools/provider.js';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../src/tools/types.js';

function make_manifest(overrides: Partial<Configured_Tool_Provider_Manifest> = {}): Configured_Tool_Provider_Manifest {
    return {
        name: 'aider',
        display_name: 'Aider',
        image_user: 'patchlab',
        image_home: '/home/patchlab',
        configuration_directory_name: '.aider',
        base_image: 'docker.io/library/python:3.12-slim',
        base_family: 'debian',
        package_manager: 'apt',
        authentication: { method: 'none' },
        launch_command: ['aider'],
        extractable_artifacts: [],
        overrides_builtin: false,
        ...overrides,
    };
}

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
        get_launch_command() { return ['stub']; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return name; },
        get_authentication_method(): Authentication_Method { return 'none'; },
        get_extractable_artifacts() { return []; },
        async inject_session_state() { /* no-op */ },
    };
}

beforeEach(() => {
    _reset_registry();
    vi.mocked(discover_user_global_manifest_paths).mockReset();
    vi.mocked(read_and_parse_manifest).mockReset();
});

describe('register_user_global_providers — no manifests discovered', () => {
    it('returns silently when no manifests are present (typical clean dev environment)', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([]);
        expect(() => register_user_global_providers()).not.toThrow();
    });
});

describe('register_user_global_providers — built-in name collision (task 6.10)', () => {
    it('rejects a manifest whose name matches a built-in without overrides_builtin: true', () => {
        register_provider(make_stub_builtin());

        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([`/manifests/${BUILT_IN_STUB}.yaml`]);
        vi.mocked(read_and_parse_manifest).mockReturnValue(
            make_manifest({ name: BUILT_IN_STUB, overrides_builtin: false }),
        );

        expect(() => register_user_global_providers()).toThrow(/conflicts with a built-in.*overrides_builtin/);
    });

    it('accepts a manifest that opts into shadowing via overrides_builtin: true', () => {
        register_provider(make_stub_builtin());

        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([`/manifests/${BUILT_IN_STUB}.yaml`]);
        vi.mocked(read_and_parse_manifest).mockReturnValue(
            make_manifest({ name: BUILT_IN_STUB, overrides_builtin: true, display_name: 'Shadowed built-in stub' }),
        );

        expect(() => register_user_global_providers()).not.toThrow();
        const after = get_provider(BUILT_IN_STUB);
        expect(after.display_name).toBe('Shadowed built-in stub');
        expect(get_provider_source(BUILT_IN_STUB)).toEqual({
            kind: 'user-global',
            manifest_path: `/manifests/${BUILT_IN_STUB}.yaml`,
        });
    });
});

describe('register_user_global_providers — manifest parse error (task 3.4)', () => {
    let recording: RecordingLogger;

    beforeEach(() => {
        recording = new RecordingLogger();
        set_logger(recording);
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    it('aborts startup with a thrown error when a manifest fails to parse', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue(['/manifests/broken.yaml']);
        vi.mocked(read_and_parse_manifest).mockReturnValue({
            manifest_path: '/manifests/broken.yaml',
            field_path: 'launch_command',
            reason: "missing required field 'launch_command'",
        });

        expect(() => register_user_global_providers()).toThrow(/Aborting startup.*broken\.yaml/);
        // Standardized format_warning shape was emitted
        const errors = recording.calls
            .filter((call) => call.method === 'error')
            .map((call) => String(call.message));
        expect(errors.some((e) => e.includes('rejected') && e.includes('launch_command'))).toBe(true);
    });
});

describe('register_user_global_providers — within-scope name collision (task 6.9)', () => {
    it('rejects two manifests under user-global declaring the same name', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([
            '/manifests/aider-a.yaml',
            '/manifests/aider-b.yaml',
        ]);
        vi.mocked(read_and_parse_manifest)
            .mockReturnValueOnce(make_manifest({ name: 'aider' }))
            .mockReturnValueOnce(make_manifest({ name: 'aider', display_name: 'Aider (dup)' }));

        expect(() => register_user_global_providers()).toThrow(/name conflict|Manifest name conflict|aider/);
    });
});

describe('register_user_global_providers — happy path (task 6.10, task 6.13 unit-level)', () => {
    it('registers a fresh user-global manifest and records source metadata', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue(['/manifests/aider.yaml']);
        vi.mocked(read_and_parse_manifest).mockReturnValue(make_manifest({ name: 'aider' }));

        register_user_global_providers();

        const provider = get_provider('aider');
        expect(provider.name).toBe('aider');
        expect(provider.display_name).toBe('Aider');
        expect(get_provider_source('aider')).toEqual({
            kind: 'user-global',
            manifest_path: '/manifests/aider.yaml',
        });

        // Configured_Tool_Provider exposes manifest_path and manifest_hash for the
        // image-build/cache flow.
        const as_configured = provider as Tool_Provider & { manifest_path?: string; manifest_hash?: string };
        expect(as_configured.manifest_path).toBe('/manifests/aider.yaml');
        expect(as_configured.manifest_hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('registers multiple distinct manifests', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([
            '/manifests/aider.yaml',
            '/manifests/cline.yaml',
        ]);
        vi.mocked(read_and_parse_manifest)
            .mockReturnValueOnce(make_manifest({ name: 'aider' }))
            .mockReturnValueOnce(make_manifest({ name: 'cline', display_name: 'Cline' }));

        register_user_global_providers();
        expect(get_provider('aider').name).toBe('aider');
        expect(get_provider('cline').name).toBe('cline');
    });
});

describe('register_user_global_providers — collect-and-skip mode (task 0a.4)', () => {
    it('returns parse errors without throwing, even when every manifest is broken', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([
            '/manifests/broken-a.yaml',
            '/manifests/broken-b.yaml',
        ]);
        vi.mocked(read_and_parse_manifest)
            .mockReturnValueOnce({
                manifest_path: '/manifests/broken-a.yaml',
                field_path: 'launch_command',
                reason: "missing required field 'launch_command'",
            })
            .mockReturnValueOnce({
                manifest_path: '/manifests/broken-b.yaml',
                field_path: 'authentication',
                reason: 'invalid method',
            });

        const result = register_user_global_providers({ mode: 'collect-and-skip' });
        expect(result.errors).toHaveLength(2);
        expect(result.errors[0].manifest_path).toBe('/manifests/broken-a.yaml');
        expect(result.errors[1].manifest_path).toBe('/manifests/broken-b.yaml');
    });

    it('registers well-formed manifests AND collects parse errors for the broken ones in the same pass', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([
            '/manifests/aider.yaml',
            '/manifests/broken.yaml',
        ]);
        vi.mocked(read_and_parse_manifest)
            .mockReturnValueOnce(make_manifest({ name: 'aider' }))
            .mockReturnValueOnce({
                manifest_path: '/manifests/broken.yaml',
                field_path: '',
                reason: 'YAML parse error: bad indentation',
            });

        const result = register_user_global_providers({ mode: 'collect-and-skip' });

        // Well-formed manifest registered
        expect(get_provider('aider').name).toBe('aider');
        // Broken manifest collected as error
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].manifest_path).toBe('/manifests/broken.yaml');
    });

    it('converts built-in collisions into a Manifest_Parse_Error rather than throwing', () => {
        register_provider(make_stub_builtin());

        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([`/manifests/${BUILT_IN_STUB}.yaml`]);
        vi.mocked(read_and_parse_manifest).mockReturnValue(
            make_manifest({ name: BUILT_IN_STUB, overrides_builtin: false }),
        );

        const result = register_user_global_providers({ mode: 'collect-and-skip' });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].field_path).toBe('overrides_builtin');
        expect(result.errors[0].reason).toContain('conflicts with a built-in');
        const after = get_provider(BUILT_IN_STUB);
        expect(after.display_name).toBe(`Stub ${BUILT_IN_STUB}`);
    });

    it('converts within-scope name conflicts into a Manifest_Parse_Error rather than throwing', () => {
        vi.mocked(discover_user_global_manifest_paths).mockReturnValue([
            '/manifests/aider-a.yaml',
            '/manifests/aider-b.yaml',
        ]);
        vi.mocked(read_and_parse_manifest)
            .mockReturnValueOnce(make_manifest({ name: 'aider' }))
            .mockReturnValueOnce(make_manifest({ name: 'aider', display_name: 'Aider (dup)' }));

        const result = register_user_global_providers({ mode: 'collect-and-skip' });
        // First wins; second is reported as an error
        expect(get_provider('aider').display_name).toBe('Aider');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].manifest_path).toBe('/manifests/aider-b.yaml');
        expect(result.errors[0].reason).toContain('name conflict');
    });
});
