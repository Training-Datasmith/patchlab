import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    discover_per_source_manifest_paths,
    discover_user_global_manifest_paths,
    expand_container_path,
    expand_host_path,
    format_warning,
    parse_manifest,
    read_and_parse_manifest,
    assert_no_within_scope_name_conflicts,
    type Configured_Tool_Provider_Manifest,
    type Manifest_Parse_Error,
} from '../../../../src/tools/configured_provider/index.js';
import { ARCHIVE_SUBPATH_REJECTION_FIXTURE } from '../../../../src/extractable_artifact.js';

const MANIFEST_PATH = '/some/dir/aider.yaml';

function is_manifest(
    result: Configured_Tool_Provider_Manifest | Manifest_Parse_Error
): result is Configured_Tool_Provider_Manifest {
    return !('field_path' in result && 'reason' in result);
}

function is_error(
    result: Configured_Tool_Provider_Manifest | Manifest_Parse_Error
): result is Manifest_Parse_Error {
    return !is_manifest(result);
}

function minimal_yaml(extra: string = ''): string {
    return [
        'name: aider',
        'display_name: Aider',
        'image_user: patchlab',
        'base_image: ghcr.io/me/aider:latest',
        'authentication:',
        '  method: none',
        'launch_command: [aider]',
        extra,
    ].filter(Boolean).join('\n');
}

describe('parse_manifest — well-formed (7.1)', () => {
    it('parses a minimal manifest with method: none', () => {
        const result = parse_manifest(minimal_yaml(), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.name).toBe('aider');
        expect(result.display_name).toBe('Aider');
        expect(result.image_user).toBe('patchlab');
        expect(result.image_home).toBe('/home/patchlab');
        expect(result.configuration_directory_name).toBe('.aider');
        expect(result.authentication).toEqual({ method: 'none' });
        expect(result.launch_command).toEqual(['aider']);
        expect(result.extractable_artifacts).toEqual([]);
        expect(result.overrides_builtin).toBe(false);
    });

    it('parses a manifest with environment_variables auth', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication:',
            '  method: environment_variables',
            '  variable_names: [OPENAI_API_KEY, GITHUB_TOKEN]',
            'launch_command: [aider, --interactive]',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.authentication).toEqual({
            method: 'environment_variables',
            variable_names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
        });
        expect(result.launch_command).toEqual(['aider', '--interactive']);
    });

    it('parses a manifest with file_copy auth (paths expanded)', () => {
        const original_home = process.env.HOME;
        process.env.HOME = '/home/test-user';
        try {
            const yaml_text = [
                'name: aider',
                'display_name: Aider',
                'image_user: patchlab',
                'base_image: ghcr.io/me/aider:latest',
                'authentication:',
                '  method: file_copy',
                '  copies:',
                '    - host: $HOME/.aider/config.yml',
                '      container: $HOME/.aider/config.yml',
                'launch_command: [aider]',
            ].join('\n');
            const result = parse_manifest(yaml_text, MANIFEST_PATH, {
                homedir_resolver: () => '/home/test-user',
            });
            expect(is_manifest(result)).toBe(true);
            if (!is_manifest(result) || result.authentication.method !== 'file_copy') {
                return;
            }

            expect(result.authentication.copies).toEqual([
                {
                    host: '/home/test-user/.aider/config.yml',
                    container: '/home/patchlab/.aider/config.yml',
                    uses_home_expansion: true,
                },
            ]);
        } finally {
            if (original_home === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = original_home;
            }
        }
    });
});

describe('parse_manifest — malformed (7.2)', () => {
    it('rejects a manifest missing launch_command', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication: { method: none }',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('launch_command');
        expect(result.manifest_path).toBe(MANIFEST_PATH);
    });

    it('rejects a manifest with unknown top-level fields', () => {
        const result = parse_manifest(minimal_yaml('authenticate: bogus'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('authenticate');
        expect(result.reason).toMatch(/unknown/);
    });

    it('rejects an invalid authentication method', () => {
        const yaml_text = minimal_yaml().replace('method: none', 'method: bogus');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('authentication.method');
    });
});

describe('name regex (7.3 + 7.4o)', () => {
    it('rejects name with uppercase / underscores', () => {
        const yaml_text = minimal_yaml().replace('name: aider', 'name: My_Tool');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.reason).toMatch(/\^\[a-z0-9-\]\+\$/);
    });

    it('rejects empty name', () => {
        const yaml_text = minimal_yaml().replace('name: aider', 'name: ""');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('accepts name = "-" (single hyphen)', () => {
        const yaml_text = minimal_yaml().replace('name: aider', 'name: "-"');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
    });

    it('accepts name = "--" (double hyphen)', () => {
        const yaml_text = minimal_yaml().replace('name: aider', 'name: "--"');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
    });
});

describe('archive_subpath validation via shared fixture (7.4)', () => {
    function manifest_with_subpath(subpath: string): string {
        return [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication: { method: none }',
            'launch_command: [aider]',
            'extractable_artifacts:',
            '  - name: chat',
            '    container_path: /tmp/chat',
            '    type: directory',
            `    archive_subpath: ${JSON.stringify(subpath)}`,
            '    required_for_resume: false',
        ].join('\n');
    }

    it.each(ARCHIVE_SUBPATH_REJECTION_FIXTURE)(
        'rejects archive_subpath value $value (rule: $rule)',
        ({ value }) => {
            const result = parse_manifest(manifest_with_subpath(value), MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
        }
    );

    function manifest_with_configuration_directory_name(value: string): string {
        return [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            `configuration_directory_name: ${JSON.stringify(value)}`,
            'base_image: ghcr.io/me/aider:latest',
            'authentication: { method: none }',
            'launch_command: [aider]',
        ].join('\n');
    }

    it.each(ARCHIVE_SUBPATH_REJECTION_FIXTURE)(
        'rejects configuration_directory_name value $value (rule: $rule)',
        ({ value }) => {
            const result = parse_manifest(
                manifest_with_configuration_directory_name(value),
                MANIFEST_PATH
            );
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }

            expect(result.field_path).toBe('configuration_directory_name');
        }
    );
});

describe('extractable_artifacts uniqueness (7.4a, 7.4b)', () => {
    function manifest_with_artifacts(entries: string): string {
        return [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication: { method: none }',
            'launch_command: [aider]',
            'extractable_artifacts:',
            entries,
        ].join('\n');
    }

    it('rejects case-only-different archive_subpath values', () => {
        const result = parse_manifest(manifest_with_artifacts(
            '  - { name: a, container_path: /tmp/a, type: directory, archive_subpath: State, required_for_resume: false }\n'
            + '  - { name: b, container_path: /tmp/b, type: directory, archive_subpath: state, required_for_resume: false }'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects duplicate name values (case-sensitive)', () => {
        const result = parse_manifest(manifest_with_artifacts(
            '  - { name: chat, container_path: /tmp/a, type: directory, archive_subpath: a, required_for_resume: false }\n'
            + '  - { name: chat, container_path: /tmp/b, type: directory, archive_subpath: b, required_for_resume: false }'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('accepts case-only-different names (Foo vs foo)', () => {
        const result = parse_manifest(manifest_with_artifacts(
            '  - { name: Foo, container_path: /tmp/a, type: directory, archive_subpath: a, required_for_resume: false }\n'
            + '  - { name: foo, container_path: /tmp/b, type: directory, archive_subpath: b, required_for_resume: false }'
        ), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
    });
});

describe('image_user / image_home (7.4c, 7.4d, 7.4e)', () => {
    it('rejects image_user with separators', () => {
        const yaml_text = minimal_yaml().replace('image_user: patchlab', 'image_user: ../../etc');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('image_user');
    });

    it('defaults image_home to /root for image_user: root', () => {
        const yaml_text = minimal_yaml().replace('image_user: patchlab', 'image_user: root');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.image_home).toBe('/root');
    });

    it('defaults image_home to /home/<user> for non-root', () => {
        const result = parse_manifest(minimal_yaml(), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.image_home).toBe('/home/patchlab');
    });

    it('accepts explicit image_home override', () => {
        const yaml_text = minimal_yaml('image_home: /var/lib/postgres');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.image_home).toBe('/var/lib/postgres');
    });

    it('rejects malformed image_home (relative)', () => {
        const yaml_text = minimal_yaml('image_home: ../etc');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('expands container path against image_home', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: root',
            'base_image: ghcr.io/me/aider:latest',
            'authentication:',
            '  method: file_copy',
            '  copies:',
            '    - host: /etc/config',
            '      container: $HOME/.aider/config',
            'launch_command: [aider]',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result) || result.authentication.method !== 'file_copy') {
            return;
        }
        expect(result.authentication.copies[0].container).toBe('/root/.aider/config');
    });
});

describe('dockerfile (7.4f, 7.4m, 7.4n)', () => {
    it('passes through dockerfile.environment values verbatim', () => {
        const yaml_text = minimal_yaml(
            'dockerfile:\n  environment: { CACHE_DIR: "$HOME/.cache" }'
        );
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.dockerfile?.environment.CACHE_DIR).toBe('$HOME/.cache');
    });

    it('rejects empty install entries', () => {
        const yaml_text = minimal_yaml('dockerfile:\n  install: ["", "echo done"]');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('accepts empty install array', () => {
        const yaml_text = minimal_yaml('dockerfile:\n  install: []');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.dockerfile?.install).toEqual([]);
    });

    it('rejects environment key with =', () => {
        const yaml_text = minimal_yaml('dockerfile:\n  environment: { "KEY=BAD": value }');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('accepts environment with empty value (override pattern)', () => {
        const yaml_text = minimal_yaml('dockerfile:\n  environment: { HTTP_PROXY: "" }');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.dockerfile?.environment.HTTP_PROXY).toBe('');
    });
});

describe('empty arrays (7.4g)', () => {
    it('rejects empty launch_command', () => {
        const yaml_text = minimal_yaml().replace('launch_command: [aider]', 'launch_command: []');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('launch_command');
    });

    it('rejects empty validation.command', () => {
        const yaml_text = minimal_yaml('validation:\n  command: []');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects empty file_copy copies list', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication:',
            '  method: file_copy',
            '  copies: []',
            'launch_command: [aider]',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });
});

describe('container path rejection (7.4h, 7.4l)', () => {
    it('rejects plain relative container paths in copies', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication:',
            '  method: file_copy',
            '  copies:',
            '    - host: /etc/config',
            '      container: cache.json',
            'launch_command: [aider]',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects plain relative container_path on extractable_artifacts', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication: { method: none }',
            'launch_command: [aider]',
            'extractable_artifacts:',
            '  - { name: chat, container_path: cache.json, type: file, archive_subpath: chat, required_for_resume: false }',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });
});

describe('display_name + base_image (7.4j)', () => {
    it('rejects empty display_name', () => {
        const yaml_text = minimal_yaml().replace('display_name: Aider', 'display_name: ""');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects whitespace-only display_name', () => {
        const yaml_text = minimal_yaml().replace('display_name: Aider', 'display_name: "   "');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects empty base_image', () => {
        const yaml_text = minimal_yaml().replace('base_image: ghcr.io/me/aider:latest', 'base_image: ""');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });
});

describe('per-artifact field validation (7.4k)', () => {
    function with_artifact(properties: string): string {
        return [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication: { method: none }',
            'launch_command: [aider]',
            'extractable_artifacts:',
            `  - { ${properties} }`,
        ].join('\n');
    }

    it('rejects artifact name = ""', () => {
        const result = parse_manifest(with_artifact(
            'name: "", container_path: /tmp/x, type: file, archive_subpath: data, required_for_resume: false'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects artifact name with leading whitespace', () => {
        const result = parse_manifest(with_artifact(
            'name: "  bad", container_path: /tmp/x, type: file, archive_subpath: data, required_for_resume: false'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects artifact type = "FILE" (uppercase)', () => {
        const result = parse_manifest(with_artifact(
            'name: x, container_path: /tmp/x, type: FILE, archive_subpath: data, required_for_resume: false'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects artifact type = "symlink"', () => {
        const result = parse_manifest(with_artifact(
            'name: x, container_path: /tmp/x, type: symlink, archive_subpath: data, required_for_resume: false'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects required_for_resume = "true" (string instead of boolean)', () => {
        const result = parse_manifest(with_artifact(
            'name: x, container_path: /tmp/x, type: file, archive_subpath: data, required_for_resume: "true"'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });

    it('rejects required_for_resume = 1', () => {
        const result = parse_manifest(with_artifact(
            'name: x, container_path: /tmp/x, type: file, archive_subpath: data, required_for_resume: 1'
        ), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
    });
});

describe('absolute host paths (7.4i)', () => {
    it('passes POSIX absolute host path through unchanged', () => {
        expect(expand_host_path('/etc/config', '/anywhere', 'host')).toBe('/etc/config');
    });

    it('passes Windows drive-letter absolute host path through unchanged', () => {
        expect(expand_host_path(
            String.raw`C:\Users\claude\config.json`, String.raw`C:\anywhere`, 'host'))
            .toBe(String.raw`C:\Users\claude\config.json`);
    });
});

describe('host path expansion (7.5, 7.4p, 7.4q, 7.4r)', () => {
    const homedir = () => '/home/test';

    it('expands ~ to homedir', () => {
        expect(expand_host_path('~/.tool/credentials', '/anywhere', 'host', homedir))
            .toBe('/home/test/.tool/credentials');
    });

    it('expands $HOME to homedir', () => {
        expect(expand_host_path('$HOME/.tool/credentials', '/anywhere', 'host', homedir))
            .toBe('/home/test/.tool/credentials');
    });

    it('expands $VAR against process.env', () => {
        const original_my_var = process.env.MY_VAR;
        try {
            process.env.MY_VAR = '/some/path';
            expect(expand_host_path('$MY_VAR/file', '/anywhere', 'host', homedir))
                .toBe('/some/path/file');
        } finally {
            if (original_my_var === undefined) {
                delete process.env.MY_VAR;
            } else {
                process.env.MY_VAR = original_my_var;
            }
        }
    });

    it('fails on unresolved $VAR', () => {
        const original_undefined_var = process.env.UNDEFINED_VAR;
        try {
            delete process.env.UNDEFINED_VAR;
            expect(() => expand_host_path('$UNDEFINED_VAR/file', '/anywhere', 'host', homedir))
                .toThrow(/UNDEFINED_VAR/);
        } finally {
            if (original_undefined_var !== undefined) {
                process.env.UNDEFINED_VAR = original_undefined_var;
            }
        }
    });

    it('expands empty $VAR to empty string (string-substitution semantics)', () => {
        const original_tool_prefix = process.env.TOOL_PREFIX;
        try {
            process.env.TOOL_PREFIX = '';
            expect(expand_host_path('$TOOL_PREFIX/data.json', '/anywhere', 'host', homedir))
                .toBe('/data.json');
        } finally {
            if (original_tool_prefix === undefined) {
                delete process.env.TOOL_PREFIX;
            } else {
                process.env.TOOL_PREFIX = original_tool_prefix;
            }
        }
    });

    it('handles multiple $VAR segments', () => {
        const original_a = process.env.A;
        const original_b = process.env.B;
        try {
            process.env.A = 'aa';
            process.env.B = 'bb';
            expect(expand_host_path('/$A/$B/file', '/anywhere', 'host', homedir))
                .toBe('/aa/bb/file');
        } finally {
            if (original_a === undefined) {
                delete process.env.A;
            } else {
                process.env.A = original_a;
            }
            if (original_b === undefined) {
                delete process.env.B;
            } else {
                process.env.B = original_b;
            }
        }
    });

    it('rejects ~user (other-user home) syntax', () => {
        expect(() => expand_host_path('~alice/.config/tool', '/anywhere', 'host', homedir))
            .toThrow(/~user/);
    });

    it('rejects null bytes in the resolved path', () => {
        // Inject the null byte through homedir_resolver rather than process.env:
        // Node on Windows strips null bytes at the OS layer when assigning to
        // process.env, but the homedir resolver runs in pure JS and lets us
        // exercise the same `reject_null_bytes` defense on every platform.
        expect(() => expand_host_path('~/foo', '/anywhere', 'host', () => '\0bad'))
            .toThrow(/null byte/);
    });

    it('resolves plain relative against manifest directory', () => {
        expect(expand_host_path('./template.json', '/source/.patchlab/tools', 'host', homedir))
            .toBe(path.resolve('/source/.patchlab/tools', './template.json'));
    });

    it('fails when homedir cannot be determined', () => {
        expect(() => expand_host_path('~/foo', '/anywhere', 'host', () => null))
            .toThrow(/home directory could not be determined/);
    });
});

describe('container path expansion (7.6, 7.7)', () => {
    it('expands ~ to image_home', () => {
        expect(expand_container_path('~/.tool', '/home/patchlab', 'container'))
            .toBe('/home/patchlab/.tool');
    });

    it('expands $HOME to image_home (NOT host home)', () => {
        expect(expand_container_path('$HOME/.tool', '/home/patchlab', 'container'))
            .toBe('/home/patchlab/.tool');
    });

    it('expands ~ for root user to /root', () => {
        expect(expand_container_path('$HOME/.tool', '/root', 'container'))
            .toBe('/root/.tool');
    });

    it('passes absolute /-paths through', () => {
        expect(expand_container_path('/etc/tool/config', '/home/patchlab', 'container'))
            .toBe('/etc/tool/config');
    });

    it('rejects other $VAR references', () => {
        expect(() => expand_container_path('$RUNTIME_DIR/socket', '/home/patchlab', 'container'))
            .toThrow(/only expand `~` and `\$HOME`/);
    });

    it('rejects $VAR embedded inside an absolute path (no smuggling)', () => {
        expect(() => expand_container_path('/etc/$RUNTIME_DIR/socket', '/home/patchlab', 'container'))
            .toThrow(/only expand `~` and `\$HOME`/);
    });

    it('rejects $VAR embedded mid-path under absolute root', () => {
        expect(() => expand_container_path('/var/lib/$SERVICE/data', '/home/patchlab', 'container'))
            .toThrow(/only expand `~` and `\$HOME`/);
    });

    it('rejects $VAR smuggled past a $HOME prefix', () => {
        expect(() => expand_container_path('$HOME/$RUNTIME_DIR/foo', '/home/patchlab', 'container'))
            .toThrow(/only expand `~` and `\$HOME`/);
    });

    it('rejects $VAR smuggled past a ~ prefix', () => {
        expect(() => expand_container_path('~/$RUNTIME_DIR/foo', '/home/patchlab', 'container'))
            .toThrow(/only expand `~` and `\$HOME`/);
    });

    it('rejects a literal $ in an absolute container path', () => {
        expect(() => expand_container_path('/opt/$weird-but-legal-filename', '/home/patchlab', 'container'))
            .toThrow(/only expand `~` and `\$HOME`/);
    });

    it('rejects plain relative paths', () => {
        expect(() => expand_container_path('cache.json', '/home/patchlab', 'container'))
            .toThrow(/no stable container-side anchor/);
    });
});

describe('plain field passthrough (7.10)', () => {
    it('does not expand $VAR in display_name', () => {
        const yaml_text = minimal_yaml().replace('display_name: Aider', 'display_name: "Aider $VERSION"');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.display_name).toBe('Aider $VERSION');
    });

    it('does not expand $VAR in launch_command tokens', () => {
        const yaml_text = minimal_yaml().replace(
            'launch_command: [aider]',
            'launch_command: [aider, "--message", "$USER asked for cleanup"]'
        );
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.launch_command[2]).toBe('$USER asked for cleanup');
    });
});

describe('discovery (7.11, 7.12, 7.13, 7.4s)', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-discover-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('discovers .yaml and .yml files only', () => {
        fs.writeFileSync(path.join(temporary_directory, 'aider.yaml'), '');
        fs.writeFileSync(path.join(temporary_directory, 'codex.yml'), '');
        fs.writeFileSync(path.join(temporary_directory, 'note.txt'), '');
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        fs.mkdirSync(tools_directory, { recursive: true });
        fs.writeFileSync(path.join(tools_directory, 'aider.yaml'), '');
        fs.writeFileSync(path.join(tools_directory, 'codex.yml'), '');
        fs.writeFileSync(path.join(tools_directory, 'note.txt'), '');
        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p)).sort()).toEqual( // NOSONAR
            ['aider.yaml', 'codex.yml']);
    });

    it('returns [] when scope directory does not exist', () => {
        expect(discover_per_source_manifest_paths(temporary_directory)).toEqual([]);
    });

    it('skips entries in subdirectories', () => {
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        const sub = path.join(tools_directory, 'sub');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, 'nested.yaml'), '');
        fs.writeFileSync(path.join(tools_directory, 'top.yaml'), '');
        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p))).toEqual(['top.yaml']);
    });

    it('skips editor-backup files', () => {
        // Backup-suffix files (.bak, ~, .swp, .swo) coexist with .yaml on every platform;
        // case-only collisions (.YAML vs .yaml) need a separate POSIX-only test because
        // Windows NTFS treats them as the same file.
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        fs.mkdirSync(tools_directory, { recursive: true });
        for (const filename of ['aider.yaml', 'aider.yml.bak', 'aider.yaml~', 'something.swp', 'note.swo']) {
            fs.writeFileSync(path.join(tools_directory, filename), '');
        }
        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p))).toEqual(['aider.yaml']);
    });

    // POSIX-only discovery behaviour (`.YAML` extension, symlinks) lives in
    // test/posix/configured-provider.test.ts — Windows can't simulate either.

    it('handles a YAML syntax error in one file while another parses normally', () => {
        const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
        fs.mkdirSync(tools_directory, { recursive: true });
        const broken_path = path.join(tools_directory, 'broken.yaml');
        const working_path = path.join(tools_directory, 'working.yaml');
        fs.writeFileSync(broken_path, 'name: aider\n  display_name: bad-indent: : :');
        fs.writeFileSync(working_path, minimal_yaml());

        const paths = discover_per_source_manifest_paths(temporary_directory);
        expect(paths.map((p) => path.basename(p)).sort()).toEqual( // NOSONAR
            ['broken.yaml', 'working.yaml']);

        const broken_result = read_and_parse_manifest(broken_path);
        const working_result = read_and_parse_manifest(working_path);
        expect(is_error(broken_result)).toBe(true);
        expect(is_manifest(working_result)).toBe(true);
    });

    it('user-global discovery uses ~/.patchlab/tools/', () => {
        // Override $HOME for the test so we don't pollute the real ~/.patchlab.
        const original_home = process.env.HOME;
        const original_userprofile = process.env.USERPROFILE;
        process.env.HOME = temporary_directory;
        process.env.USERPROFILE = temporary_directory;
        try {
            const tools_directory = path.join(temporary_directory, '.patchlab', 'tools');
            fs.mkdirSync(tools_directory, { recursive: true });
            fs.writeFileSync(path.join(tools_directory, 'global.yaml'), '');
            const paths = discover_user_global_manifest_paths();
            expect(paths.map((p) => path.basename(p))).toEqual(['global.yaml']);
        } finally {
            if (original_home === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = original_home;
            }

            if (original_userprofile === undefined) {
                delete process.env.USERPROFILE;
            } else {
                process.env.USERPROFILE = original_userprofile;
            }
        }
    });

    it('rejects within-scope name conflicts', () => {
        // Asserting the message format too — not just that some throw fired —
        // so a regression that dropped the "name X declared by N manifests"
        // hint (the operator's primary remediation cue) would surface here.
        const make = (name: string, p: string) => ({
            manifest: { name } as Configured_Tool_Provider_Manifest,
            manifest_path: p,
        });
        expect(() => assert_no_within_scope_name_conflicts([
            make('aider', '/a/aider.yaml'),
            make('aider', '/b/aider.yaml'),
        ])).toThrow(/Manifest name conflict at scope.*"aider".*declared by 2.*\/a\/aider\.yaml.*\/b\/aider\.yaml/);
    });

    it('accepts manifests with distinct names within scope', () => {
        const make = (name: string, p: string) => ({
            manifest: { name } as Configured_Tool_Provider_Manifest,
            manifest_path: p,
        });
        expect(() => assert_no_within_scope_name_conflicts([
            make('aider', '/a/aider.yaml'),
            make('codex', '/b/codex.yaml'),
        ])).not.toThrow();
    });
});

describe('read_and_parse_manifest filesystem hazards (7.4t)', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-fs-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('handles invalid UTF-8 with a per-file Manifest_Parse_Error', () => {
        const filename = path.join(temporary_directory, 'broken.yaml');
        fs.writeFileSync(filename, Buffer.from([0xff, 0xfe, 0xfd]));
        const result = read_and_parse_manifest(filename);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('');
        expect(result.reason).toMatch(/UTF-8/);
    });

    // POSIX-only EACCES coverage lives in test/posix/configured-provider.test.ts —
    // chmod 000 doesn't translate to EACCES on Windows, and ESM module mocking
    // for fs is invasive enough that running the real chmod path in a Linux
    // container is the cleaner choice.

    it('returns Manifest_Parse_Error for YAML syntax errors', () => {
        const filename = path.join(temporary_directory, 'broken.yaml');
        fs.writeFileSync(filename, 'name: aider\n  display_name: bad-indent');
        const result = read_and_parse_manifest(filename);
        expect(is_error(result)).toBe(true);
    });

    it('returns Manifest_Parse_Error (non-EACCES branch) when the file is missing (ENOENT)', () => {
        // The EACCES/EPERM path returns "cannot read manifest: ..." (line 116-120);
        // the else branch returns the raw error.message verbatim (line 121-125).
        // ENOENT exercises the else branch on every platform.
        const missing = path.join(temporary_directory, 'does-not-exist.yaml');
        const result = read_and_parse_manifest(missing);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.manifest_path).toBe(missing);
        expect(result.field_path).toBe('');
        // The raw error.message contains "ENOENT" — distinguishes the else branch
        // from the EACCES branch (which prefixes with "cannot read manifest:").
        expect(result.reason).toMatch(/ENOENT/);
        expect(result.reason).not.toMatch(/^cannot read manifest:/);
    });

    it('returns Manifest_Parse_Error for non-mapping root (top-level scalar)', () => {
        const result = parse_manifest('just a string', MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('');
        expect(result.reason).toMatch(/mapping/);
    });

    it('returns Manifest_Parse_Error for non-mapping root (top-level list)', () => {
        const result = parse_manifest('- item1\n- item2', MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('');
    });
});

describe('format_warning (7.14)', () => {
    it('produces the canonical template', () => {
        const warning = format_warning({
            operation: 'parse_manifest',
            provider_name: 'aider',
            action: 'rejected',
            target: 'manifest at /home/user/.patchlab/tools/aider.yaml',
            reason: "missing required field 'launch_command'",
        });
        expect(warning).toBe(
            'Warning: parse_manifest for aider: rejected manifest at /home/user/.patchlab/tools/aider.yaml: '
            + "missing required field 'launch_command'"
        );
    });

    it('handles quoted-identifier targets', () => {
        const warning = format_warning({
            operation: 'inject_authentication',
            provider_name: 'aider',
            action: 'omitted',
            target: "'OPENAI_API_KEY'",
            reason: 'variable not set in host environment',
        });
        expect(warning).toBe(
            "Warning: inject_authentication for aider: omitted 'OPENAI_API_KEY': "
            + 'variable not set in host environment'
        );
    });

    it('handles descriptive-phrase targets', () => {
        const warning = format_warning({
            operation: 'inject_session_state',
            provider_name: 'aider',
            action: 'skipped',
            target: "'messages' artifact",
            reason: 'escape-symlink found at messages/notes.txt → ../../../etc/passwd',
        });
        expect(warning).toContain("skipped 'messages' artifact:");
        expect(warning).toContain('escape-symlink');
    });
});

describe('base_family field (task 3.5)', () => {
    it('defaults to debian when omitted', () => {
        const result = parse_manifest(minimal_yaml(), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.base_family).toBe('debian');
    });

    it('accepts debian / alpine / prebuilt explicitly', () => {
        for (const family of ['debian', 'alpine', 'prebuilt'] as const) {
            const result = parse_manifest(minimal_yaml(`base_family: ${family}`), MANIFEST_PATH);
            expect(is_manifest(result)).toBe(true);
            if (!is_manifest(result)) {
                continue;
            }
            expect(result.base_family).toBe(family);
        }
    });

    it('rejects unknown values like fedora', () => {
        const result = parse_manifest(minimal_yaml('base_family: fedora'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('base_family');
        expect(result.reason).toMatch(/'debian'.*'alpine'.*'prebuilt'/);
    });

    it('rejects capitalized variants', () => {
        const result = parse_manifest(minimal_yaml('base_family: Debian'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('base_family');
    });

    it('rejects non-string coercion (numeric value)', () => {
        const result = parse_manifest(minimal_yaml('base_family: 1'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('base_family');
    });
});

describe('package_manager field (task 3.5)', () => {
    it('defaults to apt when base_family is debian (or omitted)', () => {
        const result = parse_manifest(minimal_yaml(), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.package_manager).toBe('apt');
    });

    it('defaults to apk when base_family is alpine', () => {
        const result = parse_manifest(minimal_yaml('base_family: alpine'), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.package_manager).toBe('apk');
    });

    it('defaults to undefined when base_family is prebuilt', () => {
        const result = parse_manifest(minimal_yaml('base_family: prebuilt'), MANIFEST_PATH);
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.package_manager).toBeUndefined();
    });

    it('accepts explicit apt on prebuilt (mirroring gemini\'s actual shape)', () => {
        const result = parse_manifest(
            minimal_yaml(['base_family: prebuilt', 'package_manager: apt'].join('\n')),
            MANIFEST_PATH,
        );
        expect(is_manifest(result)).toBe(true);
        if (!is_manifest(result)) {
            return;
        }
        expect(result.package_manager).toBe('apt');
        expect(result.base_family).toBe('prebuilt');
    });

    it('rejects dnf with a message naming deferred support', () => {
        const result = parse_manifest(minimal_yaml('package_manager: dnf'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('package_manager');
        expect(result.reason).toMatch(/'dnf'.*deferred|deferred.*'dnf'/);
    });

    it('rejects unknown', () => {
        const result = parse_manifest(minimal_yaml('package_manager: unknown'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('package_manager');
    });

    it('rejects capitalized variants', () => {
        const result = parse_manifest(minimal_yaml('package_manager: APT'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('package_manager');
    });

    it('rejects numeric coercion', () => {
        const result = parse_manifest(minimal_yaml('package_manager: 1'), MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('package_manager');
    });
});

describe('legacy YAML keys are rejected as unknown top-level fields (task 3.5)', () => {
    it('rejects container_user', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'container_user: patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication:',
            '  method: none',
            'launch_command: [aider]',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('container_user');
    });

    it('rejects container_home', () => {
        const yaml_text = [
            'name: aider',
            'display_name: Aider',
            'image_user: patchlab',
            'container_home: /home/patchlab',
            'base_image: ghcr.io/me/aider:latest',
            'authentication:',
            '  method: none',
            'launch_command: [aider]',
        ].join('\n');
        const result = parse_manifest(yaml_text, MANIFEST_PATH);
        expect(is_error(result)).toBe(true);
        if (!is_error(result)) {
            return;
        }
        expect(result.field_path).toBe('container_home');
    });
});

describe('parse_manifest — structural validation gaps (audit (C) row 2)', () => {
    // Coverage for HIGH-priority gaps surfaced by the configured_provider.ts
    // coverage audit. Each test exercises a single `fail()` site that the
    // pre-existing end-to-end tests didn't reach. Field-path values are the
    // load-bearing assertion: a regression that swaps two adjacent fail()
    // calls would still match the message but break field_path.

    describe('authentication block structural validation', () => {
        it('rejects an extra key under method=none (e.g., a stray variable_names left from switching strategies)', () => {
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication:\n  method: none\n  variable_names: [STRAY]',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication.variable_names');
            expect(result.reason).toMatch(/not allowed when method=none/);
        });

        it('rejects method=environment_variables when variable_names is missing', () => {
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication:\n  method: environment_variables',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication.variable_names');
            expect(result.reason).toMatch(/required when method=environment_variables/);
        });

        it('rejects empty variable_names array', () => {
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication:\n  method: environment_variables\n  variable_names: []',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication.variable_names');
            expect(result.reason).toMatch(/at least one variable/);
        });

        it('rejects a non-string variable_names entry (e.g., a number)', () => {
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication:\n  method: environment_variables\n  variable_names: [GOOD, 42]',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication.variable_names[1]');
            expect(result.reason).toMatch(/non-empty string/);
        });

        it('rejects a scalar entry in authentication.copies (must be a mapping)', () => {
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication:\n  method: file_copy\n  copies:\n    - /etc/just-a-string',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication.copies[0]');
            expect(result.reason).toMatch(/must be a mapping with `host` and `container` keys/);
        });

        it('rejects method=file_copy when copies is a scalar (not a list)', () => {
            // The empty-copies-list case is already covered; this is the
            // distinct "non-array" branch.
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication:\n  method: file_copy\n  copies: a-string-not-a-list',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication.copies');
            expect(result.reason).toMatch(/required when method=file_copy/);
        });

        it('rejects a scalar authentication block (must be a mapping)', () => {
            const yaml_text = minimal_yaml().replace(
                'authentication:\n  method: none',
                'authentication: some-string',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('authentication');
            expect(result.reason).toMatch(/must be a mapping/);
        });
    });

    describe('dockerfile block structural validation', () => {
        it('rejects a scalar dockerfile block (must be a mapping)', () => {
            const yaml_text = minimal_yaml('dockerfile: some-string');
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('dockerfile');
            expect(result.reason).toMatch(/must be a mapping/);
        });

        it('rejects an environment key containing a control character', () => {
            // `` is a SOH control character. If permitted, it would leak
            // into the built image's ENV directive and corrupt the image. The
            // reject is at L729, downstream of the L725 `=` and L722 empty
            // checks. We use a YAML string so the control byte makes it into
            // the parsed mapping key.
            const yaml_text = minimal_yaml(
                'dockerfile:\n  environment:\n    "BADKEY": value',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toMatch(/^dockerfile\.environment\./);
            expect(result.reason).toMatch(/null bytes or ASCII control characters/);
        });
    });

    describe('validation block structural validation', () => {
        it('rejects a validation block that omits command (block set but no command)', () => {
            // A user-mistake scenario: the operator declares a validation
            // block intending to add a custom check, then forgets the
            // `command:` field. Distinct from the empty-array case (L756)
            // which is already covered.
            const yaml_text = minimal_yaml('validation:\n  timeout: 30');
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('validation.command');
            expect(result.reason).toMatch(/required when validation is set/);
        });
    });

    describe('launch_command structural validation', () => {
        it('rejects a non-string token in launch_command (e.g., a number)', () => {
            // The empty-array and missing cases are covered; this is the
            // distinct "per-token type" branch.
            const yaml_text = minimal_yaml().replace(
                'launch_command: [aider]',
                'launch_command: [aider, 42]',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('launch_command[1]');
            expect(result.reason).toMatch(/must be a string/);
        });
    });

    describe('extractable_artifacts structural validation', () => {
        it('rejects extractable_artifacts as a top-level scalar (not a list)', () => {
            const yaml_text = minimal_yaml('extractable_artifacts: a-string-not-a-list');
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('extractable_artifacts');
            expect(result.reason).toMatch(/must be a list of mappings/);
        });

        it('rejects a scalar entry inside extractable_artifacts (not a mapping)', () => {
            const yaml_text = minimal_yaml('extractable_artifacts:\n  - just-a-string');
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('extractable_artifacts[0]');
            expect(result.reason).toMatch(/must be a mapping/);
        });
    });

    describe('image_home absolute-path validation', () => {
        it('rejects an image_home containing ".." segments', () => {
            // `..` would let an operator escape the image-home anchor when
            // their container-path expansions land elsewhere. Distinct from
            // the relative-path case (L194) which is already covered.
            const yaml_text = minimal_yaml().replace(
                'image_user: patchlab',
                'image_user: patchlab\nimage_home: /home/../etc',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('image_home');
            expect(result.reason).toMatch(/must not contain "\.\." segments/);
        });

        it('rejects an image_home containing a null byte', () => {
            // Null bytes would terminate the path early when handed to native
            // syscalls (write, open) but would survive YAML parsing. A
            // regression that dropped the L198 check would let an attacker-
            // controlled manifest forge file paths.
            const yaml_text = minimal_yaml().replace(
                'image_user: patchlab',
                'image_user: patchlab\nimage_home: "/home/patch lab"',
            );
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('image_home');
            expect(result.reason).toMatch(/null bytes or ASCII control characters/);
        });
    });

    describe('overrides_builtin strict-boolean validation', () => {
        it('rejects overrides_builtin: "true" (string instead of YAML boolean)', () => {
            // The YAML parser does NOT type-coerce these — `"true"` is a
            // string, not a boolean. A regression to permissive coercion
            // would silently allow shadowing a built-in. Symmetric to the
            // existing required_for_resume strict-boolean test.
            const yaml_text = minimal_yaml('overrides_builtin: "true"');
            const result = parse_manifest(yaml_text, MANIFEST_PATH);
            expect(is_error(result)).toBe(true);
            if (!is_error(result)) {
                return;
            }
            expect(result.field_path).toBe('overrides_builtin');
            expect(result.reason).toMatch(/must be a YAML boolean/);
        });
    });
});
