import { describe, it, expect, beforeEach } from 'vitest';
import { run_list_tools } from '../../src/list_tools.js';
import {
    _reset_registry,
    register_provider,
    register_with_source,
} from '../../src/tools/provider.js';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../src/tools/types.js';
import type { Manifest_Parse_Error } from '../../src/tools/configured_provider/index.js';

function make_stub_provider(name: string, display_name: string): Tool_Provider {
    return {
        name,
        display_name,
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

describe('list-tools (task 6.11)', () => {
    let logs: string[];
    let warnings: string[];

    beforeEach(() => {
        _reset_registry();
        logs = [];
        warnings = [];
    });

    it('shows built-ins and user-global manifests with their source labels', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));
        register_with_source(
            make_stub_provider('aider', 'Aider'),
            { kind: 'user-global', manifest_path: '/manifests/aider.yaml' },
        );

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
        });

        // gemini-cli-oauth labeled built-in; aider labeled user-global with manifest path
        expect(logs).toContainEqual(expect.stringMatching(/^gemini-cli-oauth\s+\(Gemini CLI \(OAuth\)\)\s+\[built-in\]/));
        expect(logs).toContainEqual(expect.stringMatching(/^aider\s+\(Aider\)\s+\[user-global: \/manifests\/aider\.yaml\]/));
    });

    it('appends [-p] when the provider supports prompt launch', () => {
        const with_prompt: Tool_Provider = {
            ...make_stub_provider('prompt-tool', 'Prompt Tool'),
            get_prompt_launch_command(prompt) {
                return ['prompt-tool', prompt];
            },
        };
        register_provider(with_prompt);

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
        });

        expect(logs).toContainEqual(expect.stringMatching(/^prompt-tool\s+\(Prompt Tool\)\s+\[built-in\]\s+\[-p\]$/));
    });

    it('reports broken manifests inline as format_warning lines and exits cleanly (task 6.11)', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));

        const error: Manifest_Parse_Error = {
            manifest_path: '/manifests/broken.yaml',
            field_path: 'launch_command',
            reason: "missing required field 'launch_command'",
        };

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [error],
        });

        // Well-formed providers still listed
        expect(logs).toContainEqual(expect.stringMatching(/^gemini-cli-oauth/));
        // Standardized format_warning shape: Warning: list_tools for <filename>: rejected ...
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('Warning: list_tools');
        expect(warnings[0]).toContain('broken.yaml');
        expect(warnings[0]).toContain('rejected');
        expect(warnings[0]).toContain('launch_command');
    });

    it('handles all manifests broken — lists built-ins and emits one warning per broken manifest', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));
        register_provider(make_stub_provider('gemini-cli-api', 'Gemini CLI (API Key)'));

        const errors: Manifest_Parse_Error[] = [
            { manifest_path: '/manifests/a.yaml', field_path: 'authentication', reason: 'invalid method' },
            { manifest_path: '/manifests/b.yaml', field_path: 'authentication', reason: 'invalid method' },
        ];

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: errors,
        });

        expect(logs.filter((l) => l.includes('built-in'))).toHaveLength(2);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('a.yaml');
        expect(warnings[1]).toContain('b.yaml');
    });

    it('renders YAML-syntax errors (field_path empty) using the manifest path as target (task 6.11)', () => {
        const error: Manifest_Parse_Error = {
            manifest_path: '/manifests/syntax-error.yaml',
            field_path: '',
            reason: 'YAML parse error: bad indentation',
        };

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [error],
        });

        // The target falls back to manifest_path when field_path is empty (root-level YAML error)
        expect(warnings[0]).toContain('/manifests/syntax-error.yaml');
        expect(warnings[0]).toContain('YAML parse error');
    });
});

describe('list-tools per-source absence and inclusion', () => {
    let logs: string[];
    let warnings: string[];

    beforeEach(() => {
        _reset_registry();
        logs = [];
        warnings = [];
    });

    it('does NOT discover per-source manifests when source_path is not provided', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
        });

        // No per-source provider; no per-source warnings
        expect(logs.some((l) => l.includes('per-source'))).toBe(false);
        expect(warnings).toHaveLength(0);
    });

    it('invokes register_per_source ONLY when source_path is provided (task 4.4)', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));

        let register_called_with: string | undefined;
        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
            source_path: '/repos/myrepo',
            register_per_source: (source_path) => {
                register_called_with = source_path;
                return [];
            },
        });

        expect(register_called_with).toBe('/repos/myrepo');
    });

    it('renders [unconfirmed] annotation on per-source entries when marker is missing or stale', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));
        register_with_source(
            make_stub_provider('repo-helper', 'Repo Helper'),
            { kind: 'per-source', manifest_path: '/repos/myrepo/.patchlab/tools/repo-helper.yaml', source_path: '/repos/myrepo' },
        );

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
            source_path: '/repos/myrepo',
            register_per_source: () => [],
            is_per_source_unconfirmed: () => true,
        });

        const per_source_line = logs.find((l) => l.includes('repo-helper'));
        expect(per_source_line).toBeDefined();
        expect(per_source_line).toContain('[per-source: /repos/myrepo/.patchlab/tools/repo-helper.yaml]');
        expect(per_source_line).toContain('[unconfirmed]');
    });

    it('omits [unconfirmed] annotation when the marker is current', () => {
        register_with_source(
            make_stub_provider('repo-helper', 'Repo Helper'),
            { kind: 'per-source', manifest_path: '/repos/myrepo/.patchlab/tools/repo-helper.yaml', source_path: '/repos/myrepo' },
        );

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
            source_path: '/repos/myrepo',
            register_per_source: () => [],
            is_per_source_unconfirmed: () => false,
        });

        const per_source_line = logs.find((l) => l.includes('repo-helper'));
        expect(per_source_line).toBeDefined();
        expect(per_source_line).not.toContain('[unconfirmed]');
    });

    it('surfaces per-source parse errors as warning lines', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));

        const broken: Manifest_Parse_Error = {
            manifest_path: '/repos/myrepo/.patchlab/tools/broken.yaml',
            field_path: 'launch_command',
            reason: "missing required field 'launch_command'",
        };

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: (line) => warnings.push(line),
            user_global_errors: [],
            source_path: '/repos/myrepo',
            register_per_source: () => [broken],
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('broken.yaml');
        expect(warnings[0]).toContain('launch_command');
    });
});

describe('list-tools output distinct from patchlab images (task 6.11 / spec scenario)', () => {
    let logs: string[];

    beforeEach(() => {
        _reset_registry();
        logs = [];
    });

    it('emits provider listings keyed by --tool name; does not emit podman image fields', () => {
        register_provider(make_stub_provider('gemini-cli-oauth', 'Gemini CLI (OAuth)'));

        run_list_tools({
            output_log: (line) => logs.push(line),
            output_warn: () => { /* drop warnings for this scenario */ },
            user_global_errors: [],
        });

        // `patchlab images` lines are repository:tag (image-id) tools: ... — not what list-tools emits
        // list-tools lines are: <name>  (<display>)  [<source>]
        expect(logs[0]).toMatch(/^gemini-cli-oauth\s+\(Gemini CLI \(OAuth\)\)\s+\[built-in\]$/);
        expect(logs[0]).not.toMatch(/\(.*\)\s+tools:/); // no `(image-id) tools:` shape
    });
});
