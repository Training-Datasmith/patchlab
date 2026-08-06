/**
 * Cross-detector utilities. None of these are detection logic on their own;
 * they're the file-walking, YAML-reading, env-var-extracting, and
 * dedup-into-result-bucket pieces that several detectors share, plus the
 * podman-socket path resolver that the socket-mount requirement depends on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parse_yaml } from 'yaml';
import { logger } from '../logger.js';
import type {
    Environment_Variable_Requirement,
    Requirement_Source,
    Sandbox_Requirement,
    Volume_Mount_Requirement,
} from './types.js';

/** Resolve the Podman socket path for the current platform.
 *  On Linux: /run/podman/podman.sock or /run/user/{uid}/podman/podman.sock
 *  On Windows (WSL): query `podman info` for the remote socket path
 */
let _cached_socket_path: string | null = null;
export function resolve_podman_socket_path(): string {
    if (_cached_socket_path) {
        return _cached_socket_path;
    }

    try {
        const output = execFileSync('podman', ['info', '--format', '{{.Host.RemoteSocket.Path}}'], {
            stdio: 'pipe',
        }).toString('utf-8').trim();
        _cached_socket_path = output.replace(/^unix:\/\//, '');
    } catch (_podman_info_failed) {
        _cached_socket_path = '/run/podman/podman.sock';
    }

    return _cached_socket_path;
}

export function socket_mount_requirement(source: Requirement_Source): Volume_Mount_Requirement {
    const host_path = resolve_podman_socket_path();
    return {
        type: 'volume_mount',
        host_path,
        container_path: '/run/podman/podman.sock',
        source,
    };
}

export function walk_files(directory: string, extensions: string[]): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
        const full_path = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') {
                continue;
            }
            results.push(...walk_files(full_path, extensions));
        } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
            results.push(full_path);
        }
    }
    return results;
}

export function extract_environment_variables(
    environment: unknown,
    source: Requirement_Source,
    requirements: Sandbox_Requirement[],
): void {
    if (!environment || typeof environment !== 'object') {
        return;
    }

    for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
        if (typeof value === 'string') {
            requirements.push({ type: 'environment_var', key, value, source });
        }
    }
}

/** Read and parse a YAML file, returning null on any failure. */
export function read_yaml_file(file_path: string): { content: string; parsed: Record<string, unknown> } | null {
    try {
        const content = fs.readFileSync(file_path, 'utf-8');
        const parsed = parse_yaml(content) as Record<string, unknown>;
        return parsed && typeof parsed === 'object' ? { content, parsed } : null;
    } catch (_yaml_read_or_parse_failed) {
        return null;
    }
}

/** Match content against tool patterns, returning requirements for all matches. */
export function match_tool_patterns(
    content: string,
    patterns: { pattern: RegExp; requirement: Sandbox_Requirement }[],
): Sandbox_Requirement[] {
    return patterns
        .filter(({ pattern }) => pattern.test(content))
        .map(({ requirement }) => requirement);
}

/** Parse array-style environment entries (KEY=VALUE strings). */
export function parse_environment_variable_array(entries: unknown[], source: Requirement_Source): Environment_Variable_Requirement[] {
    const requirements: Environment_Variable_Requirement[] = [];
    for (const entry of entries) {
        if (typeof entry !== 'string' || !entry.includes('=')) {
            continue;
        }
        const [key, ...rest] = entry.split('=');
        requirements.push({ type: 'environment_var', key, value: rest.join('='), source });
    }
    return requirements;
}

/** Deduplicate an item by key into a target array. */
export function dedupe_by_key<T>(item: T, key: string, seen: Set<string>, target: T[]): void {
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    target.push(item);
}

/** Merge an environment variable requirement, warning on value conflicts. */
export function merge_environment_variable(
    requirement: Environment_Variable_Requirement,
    seen: Map<string, Environment_Variable_Requirement>,
    target: Environment_Variable_Requirement[],
): void {
    const existing = seen.get(requirement.key);
    if (existing) {
        if (existing.value !== requirement.value && existing.source !== requirement.source) {
            logger().warn(
                `${requirement.key} found in ${requirement.source}`
                + ` and ${existing.source} — using ${existing.source} value`,
            );
        }
        return;
    }
    seen.set(requirement.key, requirement);
    target.push(requirement);
}
