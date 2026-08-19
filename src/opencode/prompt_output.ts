import { exec_container } from '../container_runtime.js';
import { logger } from '../logger.js';
import type { Launch_Context } from '../tools/types.js';
import { validate_opencode_prompt_extra_argv } from './passthrough.js';

const SYNTHESIS_PROMPT_PREFIX =
    'Based on your work above, write your response for the user. No tools — plain text only.';

/** @internal Exposed for tests. */
export function build_prompt_synthesis_followup_argv(
    prompt: string,
    context?: Launch_Context,
): string[] {
    validate_opencode_prompt_extra_argv(context?.extra_argv, context?.exec);
    const synthesis_prompt = `${SYNTHESIS_PROMPT_PREFIX}\n\nOriginal request:\n${prompt}`;
    const command = ['opencode', 'run', '--auto', '--continue'];
    if (context?.extra_argv !== undefined) {
        command.push(...context.extra_argv);
    }
    for (const file of context?.files ?? []) {
        command.push('--file', file);
    }
    command.push('--', synthesis_prompt);
    return command;
}

function normalize_workspace_path(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        return trimmed;
    }
    return trimmed.replace(/\/+$/, '') || '/';
}

function session_entry_workspace(entry: Record<string, unknown>): string | null {
    for (const key of ['directory', 'cwd', 'path', 'project', 'root'] as const) {
        const value = entry[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return null;
}

function parse_session_list_json(output: string): Record<string, unknown>[] {
    const trimmed = output.trim();
    if (trimmed === '') {
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return [];
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    );
}

function session_entry_id(entry: Record<string, unknown>): string | null {
    const id = entry.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

/** @internal Exposed for tests. */
export function parse_session_id_for_workspace(
    output: string,
    working_directory: string,
): string | null {
    const sessions = parse_session_list_json(output);
    if (sessions.length === 0) {
        return null;
    }

    const normalized_workspace = normalize_workspace_path(working_directory);
    for (const entry of sessions) {
        const workspace = session_entry_workspace(entry);
        if (workspace === null) {
            continue;
        }
        if (normalize_workspace_path(workspace) !== normalized_workspace) {
            continue;
        }
        const id = session_entry_id(entry);
        if (id !== null) {
            return id;
        }
    }

    return session_entry_id(sessions[0]);
}

/** @internal Exposed for tests. */
export function parse_latest_session_id_from_list_json(output: string): string | null {
    const sessions = parse_session_list_json(output);
    if (sessions.length === 0) {
        return null;
    }
    return session_entry_id(sessions[0]);
}

function latest_user_message_index(messages: unknown[]): number {
    let latest = -1;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== 'object') {
            continue;
        }
        const role = (message as { info?: { role?: string } }).info?.role;
        if (role === 'user') {
            latest = index;
        }
    }
    return latest;
}

function assistant_message_has_text(message: Record<string, unknown>): boolean {
    const content = message.content;
    if (typeof content === 'string' && content.trim().length > 0) {
        return true;
    }

    const parts = message.parts;
    if (!Array.isArray(parts)) {
        return false;
    }

    for (const part of parts) {
        if (!part || typeof part !== 'object') {
            continue;
        }

        const type = (part as { type?: string }).type;
        if (type !== 'text') {
            continue;
        }

        const text = (part as { text?: string; content?: string }).text
            ?? (part as { content?: string }).content;
        if (typeof text === 'string' && text.trim().length > 0) {
            return true;
        }
    }

    return false;
}

/** @internal Exposed for tests. */
export function session_export_has_assistant_text(export_data: unknown): boolean {
    if (!export_data || typeof export_data !== 'object') {
        return false;
    }

    const messages = (export_data as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
        return false;
    }

    const start_index = latest_user_message_index(messages) + 1;
    for (let index = start_index; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== 'object') {
            continue;
        }

        const role = (message as { info?: { role?: string } }).info?.role;
        if (role !== 'assistant') {
            continue;
        }

        if (assistant_message_has_text(message as Record<string, unknown>)) {
            return true;
        }
    }

    return false;
}

function exec_opencode_in_workspace(
    container_name: string,
    working_directory: string,
    command: string[],
): string {
    return exec_container(container_name, command, { cwd: working_directory });
}

function resolve_session_id(
    container_name: string,
    working_directory: string,
): string | null {
    try {
        const list_output = exec_opencode_in_workspace(
            container_name,
            working_directory,
            ['opencode', 'session', 'list', '--format', 'json', '--max-count', '1'],
        );
        return parse_session_id_for_workspace(list_output, working_directory);
    } catch (error) {
        logger().warn(
            `Could not list OpenCode sessions in ${working_directory}: `
            + `${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

function export_session_json(
    container_name: string,
    working_directory: string,
    session_id: string,
): unknown | null {
    try {
        const export_output = exec_opencode_in_workspace(
            container_name,
            working_directory,
            ['opencode', 'export', session_id, '--sanitize'],
        );
        const trimmed = export_output.trim();
        if (trimmed === '') {
            return null;
        }
        return JSON.parse(trimmed) as unknown;
    } catch (error) {
        logger().warn(
            `Could not export OpenCode session ${session_id} from ${working_directory}: `
            + `${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

/**
 * Inspect the latest OpenCode session after a prompt run. Returns synthesis argv
 * when no assistant text is present after the latest user turn; otherwise `null`.
 * Inspection failures log a warning and still return synthesis argv so truncated
 * exports do not suppress follow-up the way "text already present" would.
 */
export function maybe_opencode_prompt_output_followup(
    container_name: string,
    working_directory: string,
    prompt: string,
    context?: Launch_Context,
): string[] | null {
    const session_id = resolve_session_id(container_name, working_directory);
    if (session_id === null) {
        logger().warn(
            `OpenCode prompt follow-up could not resolve a session in ${working_directory}; `
            + 'running synthesis anyway.'
        );
        return build_prompt_synthesis_followup_argv(prompt, context);
    }

    const export_data = export_session_json(container_name, working_directory, session_id);
    if (export_data === null) {
        logger().warn(
            `OpenCode prompt follow-up could not inspect session ${session_id} in `
            + `${working_directory}; running synthesis anyway.`
        );
        return build_prompt_synthesis_followup_argv(prompt, context);
    }

    if (session_export_has_assistant_text(export_data)) {
        return null;
    }

    return build_prompt_synthesis_followup_argv(prompt, context);
}
