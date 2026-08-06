// CLI argument parsers. These helpers live in their own module — separate from
// `cli.ts` — so the argument-parsing layer can be unit-tested without dragging
// in the entire `cli.ts` import graph.

import * as os from 'node:os';
import * as path from 'node:path';
import { InvalidArgumentError } from 'commander';
import { type Apply_Mode } from './branch/index.js';
import { type Copy_Specification } from './sandbox/workspace_copies.js';

export function parse_session_number(raw: string): number {
    if (!/^\d+$/.test(raw)) {
        throw new Error(`--session expects a positive integer, got: ${raw}`);
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--session expects a positive integer, got: ${raw}`);
    }
    return value;
}

/**
 * Reject `--mount` flag counts that exceed the total number of sources. The Nth
 * `--mount` applies to the Nth source positionally (0 = primary positional,
 * 1 = first `--source`, ...); extra `--mount` flags would have no source to
 * bind to and silently drop, which would surprise the operator.
 */
export function validate_mount_count(mounts_length: number, total_sources: number): void {
    if (mounts_length > total_sources) {
        throw new Error(
            `--mount supplied ${mounts_length} times but only ${total_sources} source(s) were given. `
            + `The Nth --mount applies to the Nth source (0 = primary positional, 1 = first --source, etc.).`,
        );
    }
}

/**
 * Parse a `--copy <src>[:<dest>]` argument into a `Copy_Specification`.
 *
 * Windows drive-prefix handling: if the raw string begins with `X:\` or `X:/`,
 * the drive-letter-plus-colon belongs to the source and the destination separator
 * is searched from index 2 onward. On all other inputs the first `:` separates
 * source from destination. `~` in the source is expanded to the user home directory.
 * When no destination is given it defaults to the basename of the source. Destinations
 * that escape the workspace root (`..`) or are absolute are rejected.
 */
export function parse_copy_specification(raw: string): Copy_Specification {
    let source_raw: string;
    let destination_raw: string | undefined;

    if (/^[A-Za-z]:[/\\]/.test(raw)) {
        const separator_index = raw.indexOf(':', 2);
        if (separator_index === -1) {
            source_raw = raw;
        } else {
            source_raw = raw.slice(0, separator_index);
            destination_raw = raw.slice(separator_index + 1);
        }
    } else {
        const separator_index = raw.indexOf(':');
        if (separator_index === -1) {
            source_raw = raw;
        } else {
            source_raw = raw.slice(0, separator_index);
            destination_raw = raw.slice(separator_index + 1);
        }
    }

    const expanded_source = expand_copy_source_home(source_raw);
    const source_path = path.resolve(expanded_source);

    const destination = destination_raw ?? path.basename(expanded_source);

    if (destination === '') {
        throw new InvalidArgumentError('--copy destination cannot be empty.');
    }

    const normalized_destination = path.normalize(destination);
    if (normalized_destination.startsWith('..')) {
        throw new InvalidArgumentError(
            `--copy destination must be within the workspace root; got: ${destination}`
        );
    }
    if (path.isAbsolute(normalized_destination)) {
        throw new InvalidArgumentError(
            `--copy destination must be a relative path; got: ${destination}`
        );
    }

    return { source_path, destination };
}

function expand_copy_source_home(input: string): string {
    if (input === '~') {
        return os.homedir();
    }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}

export function resolve_apply_mode(raw: string | boolean | undefined): Apply_Mode {
    if (raw === undefined) {
        return 'cherry-pick';
    }
    if (raw === true || raw === 'commit') {
        return 'merge-commit';
    }
    if (raw === 'squash') {
        return 'merge-squash';
    }
    throw new Error(`--merge expects "commit" or "squash", got: ${raw}`);
}

