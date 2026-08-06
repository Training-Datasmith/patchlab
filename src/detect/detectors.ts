/**
 * The seven detector functions, each scanning one kind of evidence in the
 * project tree (CI workflow YAML, docker-compose, source code, package.json
 * scripts, devDependencies, env files, OpenSpec config). Each detector is
 * independent — failures stay local; the pipeline catches and logs them.
 *
 * Detectors share the helpers in `./helpers.js` for file-walking, YAML
 * parsing, pattern matching, and environment-variable extraction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reverse_map_package } from '../capabilities.js';
import { get_provider } from '../tools/index.js';
import { parse_file_as_json } from '../json_validators.js';
import { logger } from '../logger.js';
import type {
    Detector_Context,
    Sandbox_Requirement,
    System_Package_Requirement,
} from './types.js';
import {
    extract_environment_variables,
    match_tool_patterns,
    parse_environment_variable_array,
    read_yaml_file,
    socket_mount_requirement,
    walk_files,
} from './helpers.js';

/** Scan source code for container runtime calls (podman/docker). */
export function detect_source_code(directory: string): Sandbox_Requirement[] {
    const patterns = [
        /execFileSync\s*\(\s*['"](?:podman|docker)['"]/,
        /execFile\s*\(\s*['"](?:podman|docker)['"]/,
        /spawn\s*\(\s*['"](?:podman|docker)['"]/,
        /spawnSync\s*\(\s*['"](?:podman|docker)['"]/,
    ];

    const has_container_call = ['src', 'test', 'scripts']
        .map((d) => path.join(directory, d))
        .filter((d) => fs.existsSync(d))
        .flatMap((d) => walk_files(d, ['.ts', '.js', '.mjs', '.cjs']))
        .some((file) => {
            const content = fs.readFileSync(file, 'utf-8');
            return patterns.some((p) => p.test(content));
        });

    if (!has_container_call) {
        return [];
    }
    return [
        socket_mount_requirement('source_code'),
        { type: 'system_package', capability: 'podman', source: 'source_code' },
    ];
}

/** Extract system package requirements from CI install commands. */
function parse_ci_packages(content: string): System_Package_Requirement[] {
    const requirements: System_Package_Requirement[] = [];
    const install_pattern = /(?:apt-get|apk add|dnf install|yum install)\s+(?:install\s+)?(?:-y\s+)?(?:--no-install-recommends\s+)?([\w \t-]+)/g;

    for (const match of content.matchAll(install_pattern)) {
        const packages = match[1].trim().split(/\s+/);
        for (const package_name of packages) {
            if (package_name.startsWith('-') || package_name === '') {
                continue;
            }
            const capability = reverse_map_package(package_name);
            if (capability) {
                requirements.push({ type: 'system_package', capability, source: 'ci_configuration' });
            } else {
                logger().warn(`Warning: unrecognized CI package '${package_name}' — skipped`);
            }
        }
    }

    return requirements;
}

function emit_db_connection_packages(environment: unknown, requirements: Sandbox_Requirement[]): void {
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
        return;
    }
    const db_connection = ((environment as Record<string, unknown>)['DB_CONNECTION'] as string | undefined)?.toLowerCase();
    if (db_connection) {
        for (const capability of PHP_DB_CONNECTION_CAPABILITIES[db_connection] ?? []) {
            requirements.push({ type: 'system_package', capability, source: 'ci_configuration' });
        }
    }
}

/** Extract service and environment variable requirements from CI jobs. */
function extract_ci_job_requirements(jobs: unknown): Sandbox_Requirement[] {
    if (!jobs || typeof jobs !== 'object') {
        return [];
    }

    const requirements: Sandbox_Requirement[] = [];
    for (const job of Object.values(jobs)) {
        const job_obj = job as Record<string, unknown>;

        const services = job_obj?.services as Record<string, unknown> | undefined;
        if (services && typeof services === 'object') {
            for (const service_name of Object.keys(services)) {
                requirements.push({ type: 'service', name: service_name, source: 'ci_configuration' });
            }
        }

        extract_environment_variables(job_obj?.env, 'ci_configuration', requirements);
        emit_db_connection_packages(job_obj?.env, requirements);

        const steps = job_obj?.steps as Record<string, unknown>[] | undefined;
        if (Array.isArray(steps)) {
            for (const step of steps) {
                extract_environment_variables(step?.env, 'ci_configuration', requirements);
                emit_db_connection_packages(step?.env, requirements);
            }
        }
    }

    return requirements;
}

/** Parse CI configuration for package installs, services, and environment variables. */
export function detect_ci_configuration(directory: string): Sandbox_Requirement[] {
    const workflows_directory = path.join(directory, '.github', 'workflows');
    if (!fs.existsSync(workflows_directory)) {
        return [];
    }

    const files = fs.readdirSync(workflows_directory).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const requirements: Sandbox_Requirement[] = [];

    for (const file of files) {
        const result = read_yaml_file(path.join(workflows_directory, file));
        if (!result) {
            continue;
        }

        requirements.push(
            ...parse_ci_packages(result.content),
            ...extract_ci_job_requirements(result.parsed.jobs));
    }

    return requirements;
}

/** Parse docker-compose files for services and environment variables. */
export function detect_docker_compose(directory: string): Sandbox_Requirement[] {
    const compose_files = ['docker-compose.yml', 'compose.yml', 'docker-compose.override.yml'];
    const requirements: Sandbox_Requirement[] = [];

    for (const filename of compose_files) {
        const file_path = path.join(directory, filename);
        if (!fs.existsSync(file_path)) {
            continue;
        }

        const result = read_yaml_file(file_path);
        if (!result) {
            continue;
        }

        const services = result.parsed.services as Record<string, unknown> | undefined;
        if (!services || typeof services !== 'object') {
            continue;
        }

        for (const [service_name, service_config] of Object.entries(services)) {
            requirements.push({ type: 'service', name: service_name, source: 'docker_compose' });
            const configuration = service_config as Record<string, unknown>;
            const environment = configuration?.environment;
            if (Array.isArray(environment)) {
                requirements.push(...parse_environment_variable_array(environment, 'docker_compose'));
            } else {
                extract_environment_variables(environment, 'docker_compose', requirements);
            }
        }
    }

    return requirements;
}

/** Scan devDependencies for infrastructure packages. */
export function detect_dev_dependencies(directory: string): Sandbox_Requirement[] {
    const package_path = path.join(directory, 'package.json');
    if (!fs.existsSync(package_path)) {
        return [];
    }

    let p: Record<string, unknown>;
    try {
        p = parse_file_as_json(package_path) as Record<string, unknown>;
    } catch (_package_json_read_failed) {
        return [];
    }

    const dev_dependencies = p.devDependencies as Record<string, string> | undefined;
    if (!dev_dependencies) {
        return [];
    }

    const needs_socket = Object.keys(dev_dependencies).some(
        (dependency) => dependency.startsWith('@testcontainers/') || dependency === 'testcontainers',
    );

    return needs_socket ? [socket_mount_requirement('dev_dependencies')] : [];
}

/** Scan package.json scripts and Makefile for external tool references. */
export function detect_test_scripts(directory: string): Sandbox_Requirement[] {
    const tool_patterns: { pattern: RegExp; requirement: Sandbox_Requirement }[] = [
        {
            pattern: /\b(?:podman|docker)\b/,
            requirement: socket_mount_requirement('test_scripts'),
        },
        {
            pattern: /\bpsql\b/,
            requirement: { type: 'system_package', capability: 'postgres-client', source: 'test_scripts' },
        },
        {
            pattern: /\bredis-cli\b/,
            requirement: { type: 'system_package', capability: 'redis-tools', source: 'test_scripts' },
        },
    ];

    const requirements: Sandbox_Requirement[] = [];

    // Check package.json scripts
    const package_path = path.join(directory, 'package.json');
    if (fs.existsSync(package_path)) {
        try {
            const p = parse_file_as_json(package_path) as Record<string, unknown>;
            const scripts = p.scripts as Record<string, string> | undefined;
            if (scripts) {
                requirements.push(...match_tool_patterns(Object.values(scripts).join('\n'), tool_patterns));
            }
        } catch (_malformed_package_json) {
            /* malformed package.json — skip script detection */
        }
    }

    // Check Makefile
    const makefile_path = path.join(directory, 'Makefile');
    if (fs.existsSync(makefile_path)) {
        try {
            requirements.push(...match_tool_patterns(fs.readFileSync(makefile_path, 'utf-8'), tool_patterns));
        } catch (_unreadable_makefile) {
            /* unreadable Makefile — skip */
        }
    }

    return requirements;
}

function _detect_configuration_files(content: string, requirements: Sandbox_Requirement[]): void {
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }

        const equal_sign_index = trimmed.indexOf('=');
        if (equal_sign_index === -1) {
            continue;
        }

        const key = trimmed.slice(0, equal_sign_index).trim();
        if (key) {
            const value = trimmed.slice(equal_sign_index + 1).trim();
            requirements.push({ type: 'environment_var', key, value, source: 'configuration_files' });
        }
    }
}

/** Scan config files for environment variable hints. */
export function detect_configuration_files(directory: string): Sandbox_Requirement[] {
    const requirements: Sandbox_Requirement[] = [];
    const environment_files = ['.env.test', '.env.testing', '.env.ci'];

    for (const filename of environment_files) {
        const file_path = path.join(directory, filename);
        if (!fs.existsSync(file_path)) {
            continue;
        }

        try {
            _detect_configuration_files(fs.readFileSync(file_path, 'utf-8'), requirements);
        } catch (_unreadable_configuration_file) {
            /* unreadable config file — skip */
        }
    }

    return requirements;
}

/** Read composer.json and emit a capability requirement for each known ext-* entry in require and require-dev. */
export function detect_php_extensions(directory: string, context?: Readonly<Detector_Context>): Sandbox_Requirement[] {
    const composer_path = path.join(directory, 'composer.json');
    if (!fs.existsSync(composer_path)) {
        return [];
    }

    let composer: Record<string, unknown>;
    try {
        composer = parse_file_as_json(composer_path) as Record<string, unknown>;
    } catch (_malformed_composer_json) {
        return [];
    }

    const sections = [composer.require, composer['require-dev']];
    if (!context?.exclude_suggested_extensions) {
        sections.push(composer.suggest);
    }

    const requirements: Sandbox_Requirement[] = [];
    for (const section of sections) {
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            continue;
        }
        for (const key of Object.keys(section)) {
            if (!key.startsWith('ext-')) {
                continue;
            }
            const extension_name = key.slice(4);
            const capability = `php-ext-${extension_name.replaceAll('_', '-')}`;
            requirements.push({ type: 'system_package', capability, source: 'package_manifest' });
        }
    }

    return requirements;
}

function emit_lock_package_requirements(package_entry: unknown, requirements: Sandbox_Requirement[]): void {
    if (!package_entry || typeof package_entry !== 'object' || Array.isArray(package_entry)) {
        return;
    }

    const require_map = (package_entry as Record<string, unknown>).require;
    if (!require_map || typeof require_map !== 'object' || Array.isArray(require_map)) {
        return;
    }

    for (const key of Object.keys(require_map)) {
        if (!key.startsWith('ext-')) {
            continue;
        }

        const extension_name = key.slice(4);
        const capability = `php-ext-${extension_name.replaceAll('_', '-')}`;
        requirements.push({ type: 'system_package', capability, source: 'package_manifest' });
    }
}

/** Read composer.lock and emit capability requirements for all ext-* entries across all transitive dependencies. */
export function detect_php_lock_extensions(directory: string): Sandbox_Requirement[] {
    const lock_path = path.join(directory, 'composer.lock');
    if (!fs.existsSync(lock_path)) {
        return [];
    }

    let lock: Record<string, unknown>;
    try {
        lock = parse_file_as_json(lock_path) as Record<string, unknown>;
    } catch (_malformed_composer_lock) {
        return [];
    }

    const requirements: Sandbox_Requirement[] = [];
    for (const section_key of ['packages', 'packages-dev']) {
        const section = lock[section_key];
        if (Array.isArray(section)) {
            for (const package_entry of section) {
                emit_lock_package_requirements(package_entry, requirements);
            }
        }
    }

    return requirements;
}

/** Emit a composer system package requirement when composer.json is present. */
export function detect_composer(directory: string): Sandbox_Requirement[] {
    const composer_path = path.join(directory, 'composer.json');
    return fs.existsSync(composer_path)
        ? [{ type: 'system_package', capability: 'composer', source: 'package_manifest' }]
        : [];
}

/** DB_CONNECTION values found in phpunit.xml / .env and the PHP capabilities they require. */
const PHP_DB_CONNECTION_CAPABILITIES: Record<string, string[]> = {
    sqlite:     ['php-ext-pdo-sqlite', 'php-ext-sqlite3'],
    // "testing" is the conventional Laravel/testbench connection name for the
    // in-memory sqlite test database — it resolves to sqlite in practice.
    testing:    ['php-ext-pdo-sqlite', 'php-ext-sqlite3'],
    mysql:      ['php-ext-pdo-mysql'],
    mariadb:    ['php-ext-pdo-mysql'],
    pgsql:      ['php-ext-pdo-pgsql'],
    postgresql: ['php-ext-pdo-pgsql'],
};

function read_phpunit_env_entries(file_path: string): Map<string, string> {
    const entries = new Map<string, string>();
    try {
        const content = fs.readFileSync(file_path, 'utf-8');
        // Match self-closing <env>, <server>, or <const> elements with name and value attributes
        // in any attribute order, potentially spanning a single line.
        const element_pattern = /<(?:env|server|const)\b([^>]+?)\/>/gs;
        for (const element_match of content.matchAll(element_pattern)) {
            const attributes = element_match[1];
            const name_match = /\bname="([^"]+)"/.exec(attributes);
            const value_match = /\bvalue="([^"]+)"/.exec(attributes);
            if (name_match && value_match) {
                entries.set(name_match[1], value_match[1]);
            }
        }
    } catch (_unreadable_phpunit_xml) {
        // skip
    }

    return entries;
}

function read_dotenv_entries(file_path: string): Map<string, string> {
    const entries = new Map<string, string>();
    try {
        const content = fs.readFileSync(file_path, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) {
                continue;
            }
            const equal_index = trimmed.indexOf('=');
            if (equal_index === -1) {
                continue;
            }
            const key = trimmed.slice(0, equal_index).trim();
            const value = trimmed.slice(equal_index + 1).trim();
            if (key) {
                entries.set(key, value);
            }
        }
    } catch (_unreadable_dotenv) {
        // skip
    }
    return entries;
}

/** Scan phpunit.xml / phpunit.xml.dist and .env files for DB_CONNECTION to determine which PHP database driver extensions are needed. */
export function detect_php_test_config(directory: string): Sandbox_Requirement[] {
    // First writer wins — phpunit XML is more test-specific than .env
    const env_entries = new Map<string, string>();

    function merge_entries(source: Map<string, string>): void {
        for (const [key, value] of source) {
            if (!env_entries.has(key)) {
                env_entries.set(key, value);
            }
        }
    }

    for (const filename of ['phpunit.xml', 'phpunit.xml.dist']) {
        const file_path = path.join(directory, filename);
        if (fs.existsSync(file_path)) {
            merge_entries(read_phpunit_env_entries(file_path));
        }
    }

    for (const filename of ['.env.testing', '.env.test', '.env']) {
        const file_path = path.join(directory, filename);
        if (fs.existsSync(file_path)) {
            merge_entries(read_dotenv_entries(file_path));
        }
    }

    const requirements: Sandbox_Requirement[] = [];
    const db_connection = env_entries.get('DB_CONNECTION')?.toLowerCase();
    if (db_connection) {
        for (const capability of PHP_DB_CONNECTION_CAPABILITIES[db_connection] ?? []) {
            requirements.push({ type: 'system_package', capability, source: 'php_test_configuration' });
        }
    }

    return requirements;
}

/** Detect OpenSpec usage by looking for openspec/config.yaml. */
export function detect_openspec(directory: string, context?: Readonly<Detector_Context>): Sandbox_Requirement[] {
    const configuration_path = path.join(directory, 'openspec', 'config.yaml');
    if (!fs.existsSync(configuration_path)) {
        return [];
    }

    let tool_name = 'gemini';
    if (context?.tool) {
        try {
            const provider = get_provider(context.tool);
            tool_name = provider.get_openspec_tool_name();
        } catch (_unknown_tool) {
            // Unknown tool — fall back to default
        }
    }

    return [{
        type: 'npm_package',
        package: '@fission-ai/openspec',
        init_command: (tool_name === '') ? undefined : ['openspec', 'init', '--tools', tool_name],
        source: 'configuration_files',
    }];
}
