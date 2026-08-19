/**
 * Per-repository default-tool preference persistence.
 *
 * Each file at `<patchlab-home>/.patchlab/default-tool-preferences/<sha>.json`
 * records whether the user chose the repository's `default_tool` or their host
 * fallback for a specific on-disk tool name. Separate from manifest trust markers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { is_plain_object } from '../json_validators.js';
import { atomic_write_file } from '../safe_filesystem.js';
import { repository_realpath, repository_state_key } from './repository_state_key.js';

export type Default_Tool_Choice = 'repository' | 'fallback';

export interface Default_Tool_Preference {
    value: string;
    choice: Default_Tool_Choice;
    decided_at: string;
    repository_root: string;
}

export function default_tool_preference_directory(): string {
    const override = process.env.PATCHLAB_HOME;
    const home = override === undefined || override === '' ? os.homedir() : override;
    return path.join(home, '.patchlab', 'default-tool-preferences');
}

export function default_tool_preference_path(repository_root: string): string {
    return path.join(default_tool_preference_directory(), `${repository_state_key(repository_root)}.json`);
}

function parse_choice(raw: unknown): Default_Tool_Choice | null {
    if (raw === 'repository' || raw === 'fallback') {
        return raw;
    }
    return null;
}

/**
 * Read the stored preference for `repository_root`. Returns `null` when the
 * file is missing, unreadable, malformed, or missing required fields.
 */
export function read_default_tool_preference(repository_root: string): Default_Tool_Preference | null {
    const preference_path = default_tool_preference_path(repository_root);
    let raw: string;
    try {
        raw = fs.readFileSync(preference_path, 'utf-8');
    } catch (_read_failed) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (_parse_failed) {
        return null;
    }

    if (!is_plain_object(parsed)) {
        return null;
    }

    const record = parsed as {
        value?: unknown;
        choice?: unknown;
        decided_at?: unknown;
        repository_root?: unknown;
    };

    if (typeof record.value !== 'string' || record.value === '') {
        return null;
    }

    const choice = parse_choice(record.choice);
    if (choice === null) {
        return null;
    }

    return {
        value: record.value,
        choice,
        decided_at: typeof record.decided_at === 'string' ? record.decided_at : '',
        repository_root: typeof record.repository_root === 'string'
            ? record.repository_root
            : repository_realpath(repository_root),
    };
}

/**
 * Persist the user's default-tool choice for `repository_root` and the
 * `default_tool` value that was on disk when they chose.
 */
export function write_default_tool_preference(
    repository_root: string,
    value: string,
    choice: Default_Tool_Choice,
): void {
    const preference_directory = default_tool_preference_directory();
    fs.mkdirSync(preference_directory, { recursive: true });
    const preference_path = default_tool_preference_path(repository_root);
    const body: Default_Tool_Preference = {
        value,
        choice,
        decided_at: new Date().toISOString(),
        repository_root: repository_realpath(repository_root),
    };
    atomic_write_file(preference_path, JSON.stringify(body, null, 2) + '\n');
}
