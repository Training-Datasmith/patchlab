import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    dedupe_by_key,
    extract_environment_variables,
    match_tool_patterns,
    merge_environment_variable,
    parse_environment_variable_array,
    read_yaml_file,
    walk_files,
} from '../../../src/detect/helpers.js';
import type {
    Environment_Variable_Requirement,
    Sandbox_Requirement,
} from '../../../src/detect/types.js';
import { ConsoleLogger, set_logger } from '../../../src/logger.js';
import { RecordingLogger } from '../../helpers/recording_logger.js';

describe('walk_files', () => {
    let temporary: string;

    beforeEach(() => {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-walk-files-'));
    });

    afterEach(() => {
        fs.rmSync(temporary, { recursive: true, force: true });
    });

    it('returns files matching one of the extensions', () => {
        fs.writeFileSync(path.join(temporary, 'a.ts'), '');
        fs.writeFileSync(path.join(temporary, 'b.js'), '');
        fs.writeFileSync(path.join(temporary, 'README.md'), '');
        const result = walk_files(temporary, ['.ts', '.js']);
        expect(new Set(result)).toEqual(new Set([
            path.join(temporary, 'a.ts'),
            path.join(temporary, 'b.js'),
        ]));
    });

    it('recurses into subdirectories', () => {
        fs.mkdirSync(path.join(temporary, 'nested'));
        fs.writeFileSync(path.join(temporary, 'top.ts'), '');
        fs.writeFileSync(path.join(temporary, 'nested', 'deep.ts'), '');
        const result = walk_files(temporary, ['.ts']);
        expect(new Set(result)).toEqual(new Set([
            path.join(temporary, 'nested', 'deep.ts'),
            path.join(temporary, 'top.ts'),
        ]));
    });

    it('skips node_modules and .git', () => {
        fs.mkdirSync(path.join(temporary, 'node_modules'));
        fs.mkdirSync(path.join(temporary, '.git'));
        fs.writeFileSync(path.join(temporary, 'node_modules', 'mod.ts'), '');
        fs.writeFileSync(path.join(temporary, '.git', 'config.ts'), '');
        fs.writeFileSync(path.join(temporary, 'keep.ts'), '');
        const result = walk_files(temporary, ['.ts']);
        expect(result).toEqual([path.join(temporary, 'keep.ts')]);
    });

    it('returns [] when no files match', () => {
        fs.writeFileSync(path.join(temporary, 'note.txt'), '');
        expect(walk_files(temporary, ['.ts'])).toEqual([]);
    });
});

describe('extract_environment_variables', () => {
    it('pushes one requirement per string-valued entry', () => {
        const requirements: Sandbox_Requirement[] = [];
        extract_environment_variables(
            { API_KEY: 'secret', DEBUG: 'true' },
            'ci_configuration',
            requirements,
        );
        expect(requirements).toEqual([
            { type: 'environment_var', key: 'API_KEY', value: 'secret', source: 'ci_configuration' },
            { type: 'environment_var', key: 'DEBUG', value: 'true', source: 'ci_configuration' },
        ]);
    });

    it('skips non-string values', () => {
        const requirements: Sandbox_Requirement[] = [];
        extract_environment_variables(
            { NUMBER: 42, BOOL: true, NULL: null, STRING: 'kept' },
            'docker_compose',
            requirements,
        );
        expect(requirements).toEqual([
            { type: 'environment_var', key: 'STRING', value: 'kept', source: 'docker_compose' },
        ]);
    });

    it('treats falsy and non-object inputs as no-op', () => {
        const requirements: Sandbox_Requirement[] = [];
        extract_environment_variables(undefined, 'ci_configuration', requirements);
        extract_environment_variables(null, 'ci_configuration', requirements);
        extract_environment_variables('string', 'ci_configuration', requirements);
        expect(requirements).toEqual([]);
    });
});

describe('read_yaml_file', () => {
    let temporary: string;

    beforeEach(() => {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-read-yaml-'));
    });

    afterEach(() => {
        fs.rmSync(temporary, { recursive: true, force: true });
    });

    it('reads and parses a valid YAML file', () => {
        const file_path = path.join(temporary, 'config.yaml');
        fs.writeFileSync(file_path, 'name: aider\nversion: 1\n');
        const result = read_yaml_file(file_path);
        expect(result).not.toBeNull();
        expect(result?.parsed).toEqual({ name: 'aider', version: 1 });
        expect(result?.content).toBe('name: aider\nversion: 1\n');
    });

    it('returns null on missing file', () => {
        expect(read_yaml_file(path.join(temporary, 'does-not-exist.yaml'))).toBeNull();
    });

    it('returns null on YAML that parses to a non-object (scalar)', () => {
        const file_path = path.join(temporary, 'scalar.yaml');
        fs.writeFileSync(file_path, 'just-a-string\n');
        expect(read_yaml_file(file_path)).toBeNull();
    });

    it('returns null on malformed YAML', () => {
        const file_path = path.join(temporary, 'broken.yaml');
        // Unterminated quoted string is one of the few inputs `yaml` reliably rejects.
        fs.writeFileSync(file_path, 'name: "unterminated\n');
        expect(read_yaml_file(file_path)).toBeNull();
    });
});

describe('match_tool_patterns', () => {
    const PATTERNS: { pattern: RegExp; requirement: Sandbox_Requirement }[] = [
        {
            pattern: /\bpodman\b/,
            requirement: { type: 'system_package', capability: 'podman', source: 'test_scripts' },
        },
        {
            pattern: /\bpsql\b/,
            requirement: { type: 'system_package', capability: 'postgres-client', source: 'test_scripts' },
        },
    ];

    it('returns requirements for every matching pattern', () => {
        const result = match_tool_patterns('podman ps && psql --version', PATTERNS);
        expect(result.map((r) => r.type === 'system_package' ? r.capability : '')).toEqual([
            'podman',
            'postgres-client',
        ]);
    });

    it('returns [] when no patterns match', () => {
        expect(match_tool_patterns('echo hello', PATTERNS)).toEqual([]);
    });

    it('preserves the pattern order in the output', () => {
        const reordered = [PATTERNS[1], PATTERNS[0]];
        const result = match_tool_patterns('podman ps && psql', reordered);
        expect(result.map((r) => r.type === 'system_package' ? r.capability : '')).toEqual([
            'postgres-client',
            'podman',
        ]);
    });
});

describe('parse_environment_variable_array', () => {
    it('parses KEY=VALUE strings', () => {
        const result = parse_environment_variable_array(['NODE_ENV=production', 'PORT=3000'], 'docker_compose');
        expect(result).toEqual([
            { type: 'environment_var', key: 'NODE_ENV', value: 'production', source: 'docker_compose' },
            { type: 'environment_var', key: 'PORT', value: '3000', source: 'docker_compose' },
        ]);
    });

    it('preserves additional = signs in the value', () => {
        const result = parse_environment_variable_array(['BASE64=AAAA==', 'TOKEN=abc=def'], 'ci_configuration');
        expect(result[0].value).toBe('AAAA==');
        expect(result[1].value).toBe('abc=def');
    });

    it('skips entries that are not strings or lack =', () => {
        const result = parse_environment_variable_array(['KEY=val', 'no-equals', 42, null], 'ci_configuration');
        expect(result.map((r) => r.key)).toEqual(['KEY']);
    });
});

describe('dedupe_by_key', () => {
    it('pushes the item on first occurrence and updates seen', () => {
        const seen = new Set<string>();
        const target: number[] = [];
        dedupe_by_key(1, 'a', seen, target);
        expect(target).toEqual([1]);
        expect(seen.has('a')).toBe(true);
    });

    it('skips subsequent items with the same key', () => {
        const seen = new Set<string>(['a']);
        const target: number[] = [];
        dedupe_by_key(2, 'a', seen, target);
        expect(target).toEqual([]);
    });

    it('treats different keys independently', () => {
        const seen = new Set<string>();
        const target: number[] = [];
        dedupe_by_key(1, 'a', seen, target);
        dedupe_by_key(2, 'b', seen, target);
        expect(target).toEqual([1, 2]);
    });
});

describe('merge_environment_variable', () => {
    let recording: RecordingLogger;

    beforeEach(() => {
        recording = new RecordingLogger();
        set_logger(recording);
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    function make_requirement(
        key: string,
        value: string,
        source: 'ci_configuration' | 'docker_compose' = 'ci_configuration',
    ): Environment_Variable_Requirement {
        return { type: 'environment_var', key, value, source };
    }

    it('records and emits the requirement on first occurrence', () => {
        const seen = new Map<string, Environment_Variable_Requirement>();
        const target: Environment_Variable_Requirement[] = [];
        const requirement = make_requirement('DB', 'postgres://a');
        merge_environment_variable(requirement, seen, target);
        expect(target).toEqual([requirement]);
        expect(seen.get('DB')).toBe(requirement);
        expect(recording.calls).toEqual([]);
    });

    it('keeps the first-seen value when a duplicate key has a different value', () => {
        const seen = new Map<string, Environment_Variable_Requirement>();
        const target: Environment_Variable_Requirement[] = [];
        const first = make_requirement('DB', 'postgres://a', 'ci_configuration');
        const second = make_requirement('DB', 'postgres://b', 'docker_compose');
        merge_environment_variable(first, seen, target);
        merge_environment_variable(second, seen, target);
        expect(target).toEqual([first]);
        const warnings = recording.calls.filter((call) => call.method === 'warn');
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0].message)).toContain('DB');
        expect(String(warnings[0].message)).toContain('ci_configuration');
    });

    it('does not warn when the duplicate key carries the same value', () => {
        const seen = new Map<string, Environment_Variable_Requirement>();
        const target: Environment_Variable_Requirement[] = [];
        const first = make_requirement('DB', 'postgres://a', 'ci_configuration');
        const second = make_requirement('DB', 'postgres://a', 'docker_compose');
        merge_environment_variable(first, seen, target);
        merge_environment_variable(second, seen, target);
        expect(target).toEqual([first]);
        const warnings = recording.calls.filter((call) => call.method === 'warn');
        expect(warnings).toEqual([]);
    });

    it('does not warn when the duplicate key comes from the same source with a different value', () => {
        const seen = new Map<string, Environment_Variable_Requirement>();
        const target: Environment_Variable_Requirement[] = [];
        const first = make_requirement('DB_CONNECTION', 'mysql', 'ci_configuration');
        const second = make_requirement('DB_CONNECTION', 'pgsql', 'ci_configuration');
        merge_environment_variable(first, seen, target);
        merge_environment_variable(second, seen, target);
        expect(target).toEqual([first]);
        const warnings = recording.calls.filter((call) => call.method === 'warn');
        expect(warnings).toEqual([]);
    });
});
