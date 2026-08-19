import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    host_opencode_auth_path,
    host_opencode_configuration_directory,
    path_exists_as_file_or_directory,
} from './paths.js';
import { HOST_PATCHLAB_INTERNAL } from '../tools/host_access.js';

/** Restrictive mode for credential staging directories under the sandbox archive. */
export const CREDENTIAL_STAGING_DIRECTORY_MODE = 0o700;
/** Restrictive mode for staged credential files such as OpenCode auth.json. */
export const CREDENTIAL_STAGING_FILE_MODE = 0o600;

/** Loopback URL pattern for local model endpoints inside OpenCode configuration. */
const LOOPBACK_URL_PATTERN =
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?/gi;

const LOOPBACK_HOST_ENV_PATTERN =
    /^(?:OLLAMA_HOST|LMSTUDIO_HOST|LLAMA_CPP_HOST)=(.*)$/gim;

export interface Loopback_Forward {
    /** Port the model listens on at 127.0.0.1 on the host. */
    target_port: number;
    /** Port the proxy listens on (may differ when ephemeral fallback is used). */
    listen_port: number;
}

export interface Prepared_OpenCode_Host_Configuration {
    /** Staging directory under the sandbox archive; caller removes when done. */
    staging_directory: string;
    /** Files to copy host → container after create. */
    file_copies: { host_path: string; container_path: string }[];
    /** Loopback forwards required for the rewritten configuration. */
    forwards: Loopback_Forward[];
    /** Text blobs scanned for loopback URLs (for env injection). */
    scanned_text: string[];
}

export interface Prepare_OpenCode_Host_Configuration_Options {
    sandbox_directory: string;
    image_home: string;
    copy_host_configuration: boolean;
    copy_host_auth: boolean;
    proxy_local_models: boolean;
    /** When proxy is off, rewrite to this hostname with the original port. */
    rewrite_hostname?: string;
    /** Precomputed listen ports per target port (from an existing proxy). */
    listen_ports_by_target?: Map<number, number>;
}

function strip_jsonc_comments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

function collect_loopback_ports(text: string): Set<number> {
    const ports = new Set<number>();
    for (const match of text.matchAll(LOOPBACK_URL_PATTERN)) {
        const port = match[1] === undefined ? default_port_for_url(match[0]) : Number.parseInt(match[1], 10);
        if (Number.isFinite(port) && port > 0 && port <= 65535) {
            ports.add(port);
        }
    }

    for (const match of text.matchAll(LOOPBACK_HOST_ENV_PATTERN)) {
        const env_value = match[1]?.trim() ?? '';
        for (const url_match of env_value.matchAll(LOOPBACK_URL_PATTERN)) {
            const port = url_match[1] === undefined
                ? default_port_for_url(url_match[0])
                : Number.parseInt(url_match[1], 10);
            if (Number.isFinite(port) && port > 0 && port <= 65535) {
                ports.add(port);
            }
        }
        const bare_port = /:(\d+)\/?$/.exec(env_value);
        if (bare_port) {
            const port = Number.parseInt(bare_port[1], 10);
            if (Number.isFinite(port) && port > 0 && port <= 65535) {
                ports.add(port);
            }
        }
    }

    return ports;
}

function default_port_for_url(url: string): number {
    return url.startsWith('https') ? 443 : 80;
}

export function rewrite_loopback_urls(
    text: string,
    hostname: string,
    port_map: Map<number, number>,
): string {
    let result = text.replace(LOOPBACK_URL_PATTERN, (match, port_group: string | undefined) => {
        const target_port = port_group === undefined
            ? default_port_for_url(match)
            : Number.parseInt(port_group, 10);
        const listen_port = port_map.get(target_port) ?? target_port;
        const scheme = match.startsWith('https') ? 'https' : 'http';
        return `${scheme}://${hostname}:${listen_port}`;
    });

    result = result.replace(LOOPBACK_HOST_ENV_PATTERN, (line, env_value: string) => {
        const key = line.split('=')[0];
        const rewritten = env_value.trim().replace(LOOPBACK_URL_PATTERN, (match, port_group: string | undefined) => {
            const target_port = port_group === undefined
                ? default_port_for_url(match)
                : Number.parseInt(port_group, 10);
            const listen_port = port_map.get(target_port) ?? target_port;
            const scheme = match.startsWith('https') ? 'https' : 'http';
            return `${scheme}://${hostname}:${listen_port}`;
        });
        return `${key}=${rewritten}`;
    });

    return result;
}

function harden_credential_staging_directory(directory: string): void {
    fs.chmodSync(directory, CREDENTIAL_STAGING_DIRECTORY_MODE);
}

function harden_credential_staging_file(file_path: string): void {
    fs.chmodSync(file_path, CREDENTIAL_STAGING_FILE_MODE);
}

function harden_credential_staging_tree(root: string): void {
    if (!fs.existsSync(root)) {
        return;
    }

    const stats = fs.lstatSync(root);
    if (stats.isDirectory()) {
        harden_credential_staging_directory(root);
        for (const entry of fs.readdirSync(root)) {
            harden_credential_staging_tree(path.join(root, entry));
        }
        return;
    }

    if (stats.isFile() && path.basename(root) === 'auth.json') {
        harden_credential_staging_file(root);
    }
}

function copy_tree_sync(source: string, destination: string): void {
    const stats = fs.lstatSync(source);
    if (stats.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            if (entry === 'log' || entry === 'project') {
                continue;
            }
            copy_tree_sync(path.join(source, entry), path.join(destination, entry));
        }
        return;
    }

    if (stats.isFile()) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
    }
}

function collect_text_from_configuration_tree(directory: string, scanned: string[]): void {
    if (!fs.existsSync(directory)) {
        return;
    }

    for (const entry of fs.readdirSync(directory)) {
        const full_path = path.join(directory, entry);
        const stats = fs.lstatSync(full_path);
        if (stats.isDirectory()) {
            collect_text_from_configuration_tree(full_path, scanned);
            continue;
        }

        if (!stats.isFile()) {
            continue;
        }

        if (!/\.(json|jsonc)$/i.test(entry) && entry !== 'tui.json') {
            continue;
        }

        scanned.push(fs.readFileSync(full_path, 'utf-8'));
    }
}

function rewrite_configuration_files_in_tree(
    directory: string,
    hostname: string,
    port_map: Map<number, number>,
): void {
    if (!fs.existsSync(directory)) {
        return;
    }

    for (const entry of fs.readdirSync(directory)) {
        const full_path = path.join(directory, entry);
        const stats = fs.lstatSync(full_path);
        if (stats.isDirectory()) {
            rewrite_configuration_files_in_tree(full_path, hostname, port_map);
            continue;
        }

        if (!stats.isFile()) {
            continue;
        }

        if (!/\.(json|jsonc)$/i.test(entry) && entry !== 'tui.json') {
            continue;
        }

        const original = fs.readFileSync(full_path, 'utf-8');
        const rewritten = rewrite_loopback_urls(original, hostname, port_map);
        if (rewritten !== original) {
            fs.writeFileSync(full_path, rewritten, 'utf-8');
        }
    }
}

/**
 * Stage OpenCode host configuration under the sandbox archive, optionally
 * rewriting loopback model URLs for in-container access.
 *
 * Credential files (auth.json) are copied into `{sandbox}/opencode-staging/`
 * so they survive for the lifetime of the patchlab archive and can be
 * re-injected on resume. Directory and file modes are hardened immediately.
 */
export function prepare_opencode_host_configuration(
    options: Prepare_OpenCode_Host_Configuration_Options,
): Prepared_OpenCode_Host_Configuration {
    const staging_directory = path.join(options.sandbox_directory, 'opencode-staging');
    fs.mkdirSync(staging_directory, { recursive: true, mode: CREDENTIAL_STAGING_DIRECTORY_MODE });
    harden_credential_staging_directory(staging_directory);

    const container_configuration_dir = path.join(
        options.image_home,
        '.config',
        'opencode',
    );
    const container_data_dir = path.join(
        options.image_home,
        '.local',
        'share',
        'opencode',
    );

    const file_copies: { host_path: string; container_path: string }[] = [];
    const scanned_text: string[] = [];

    if (options.copy_host_configuration) {
        const host_configuration = host_opencode_configuration_directory();
        if (path_exists_as_file_or_directory(host_configuration)) {
            const staged_configuration = path.join(staging_directory, 'configuration');
            copy_tree_sync(host_configuration, staged_configuration);
            file_copies.push({
                host_path: staged_configuration,
                container_path: container_configuration_dir,
            });
        }
    }

    if (options.copy_host_auth) {
        const host_auth = host_opencode_auth_path();
        if (fs.existsSync(host_auth)) {
            const staged_auth = path.join(staging_directory, 'auth.json');
            fs.mkdirSync(path.dirname(staged_auth), {
                recursive: true,
                mode: CREDENTIAL_STAGING_DIRECTORY_MODE,
            });
            harden_credential_staging_directory(path.dirname(staged_auth));
            fs.copyFileSync(host_auth, staged_auth);
            harden_credential_staging_file(staged_auth);
            file_copies.push({
                host_path: staged_auth,
                container_path: path.join(container_data_dir, 'auth.json'),
            });
            scanned_text.push(fs.readFileSync(staged_auth, 'utf-8'));
        }
    }

    apply_sandbox_permission_overlay(file_copies);
    harden_credential_staging_tree(staging_directory);

    const all_ports = new Set<number>();
    for (const text of scanned_text) {
        for (const port of collect_loopback_ports(strip_jsonc_comments(text))) {
            all_ports.add(port);
        }
    }

    for (const copy of file_copies) {
        if (copy.host_path.endsWith('auth.json')) {
            continue;
        }

        if (fs.existsSync(copy.host_path) && fs.statSync(copy.host_path).isDirectory()) {
            collect_text_from_configuration_tree(copy.host_path, scanned_text);
        }
    }

    for (const text of scanned_text) {
        for (const port of collect_loopback_ports(strip_jsonc_comments(text))) {
            all_ports.add(port);
        }
    }

    const hostname = options.rewrite_hostname ?? HOST_PATCHLAB_INTERNAL;
    const port_map = options.listen_ports_by_target ?? new Map<number, number>();

    for (const copy of file_copies) {
        if (copy.host_path.endsWith('auth.json')) {
            continue;
        }

        if (fs.existsSync(copy.host_path) && fs.statSync(copy.host_path).isDirectory()) {
            rewrite_configuration_files_in_tree(copy.host_path, hostname, port_map);
        }
    }

    const forwards: Loopback_Forward[] = [...all_ports].sort((a, b) => a - b).map((target_port) => ({
        target_port,
        listen_port: port_map.get(target_port) ?? target_port,
    }));

    return {
        staging_directory,
        file_copies,
        forwards,
        scanned_text,
    };
}

function apply_sandbox_permission_overlay(
    file_copies: { host_path: string; container_path: string }[],
): void {
    for (const copy of file_copies) {
        if (!fs.existsSync(copy.host_path) || !fs.statSync(copy.host_path).isDirectory()) {
            continue;
        }

        for (const entry of fs.readdirSync(copy.host_path)) {
            if (!/^opencode\.jsonc?$/i.test(entry)) {
                continue;
            }

            const configuration_path = path.join(copy.host_path, entry);
            let parsed: Record<string, unknown>;
            try {
                const raw = fs.readFileSync(configuration_path, 'utf-8');
                parsed = JSON.parse(strip_jsonc_comments(raw)) as Record<string, unknown>;
            } catch {
                continue;
            }

            const permission = (parsed.permission ?? {}) as Record<string, unknown>;
            parsed.permission = {
                ...permission,
                edit: permission.edit ?? 'allow',
                bash: permission.bash ?? 'allow',
            };
            fs.writeFileSync(configuration_path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
        }
    }
}

/** Collect API keys and OPENCODE_* vars from the host environment for injection. */
export function collect_opencode_environment_variables(): Record<string, string> {
    const keys = [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GOOGLE_API_KEY',
        'GEMINI_API_KEY',
        'OPENROUTER_API_KEY',
    ] as const;

    const result: Record<string, string> = {};
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined && value !== '') {
            result[key] = value;
        }
    }

    for (const [key, value] of Object.entries(process.env)) {
        if ((value === undefined) || (value === '') || !key.startsWith('OPENCODE_')
            || (key === 'OPENCODE_CONFIG') || (key === 'OPENCODE_CONFIG_CONTENT'))
        {
            continue;
        }

        result[key] = value;
    }

    return result;
}
