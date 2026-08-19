import { get_provider } from './provider.js';
import type { Loaded_Configuration } from '../configuration.js';
import { OPENCODE_TOOL_NAME } from '../opencode/index.js';

export const DEFAULT_BUILTIN_TOOL = OPENCODE_TOOL_NAME;

/**
 * Result of `verify_per_source_default_tool` when the CLI omitted `--tool`.
 *
 * - Non-empty `override`: use this tool name (repository policy confirmed, or
 *   non-interactive opt-in applied the unanimous repository value).
 * - `null`: use user-global `default_tool` then built-in OpenCode (host
 *   fallback — user chose their default or multi-repo create ignored stored
 *   per-repo preferences).
 *
 * Never construct this with `override: undefined`; omission of the whole
 * resolution means verify did not run (CLI passed `--tool`).
 */
export interface Per_Source_Default_Tool_Resolution {
    override: string | null;
}

/**
 * Resolve the tool name for `patchlab create`.
 *
 * Precedence:
 *   1. CLI `--tool`
 *   2. `per_source_override` when verify ran:
 *      - non-empty string → that tool name
 *      - `null` → skip to user-global / built-in (host fallback)
 *   3. User-global `default_tool` (when verify skipped or override is `null`)
 *   4. Built-in OpenCode
 *
 * @param per_source_override - Optional third argument from
 *   `verify_per_source_default_tool`. Omit entirely when CLI `--tool` was
 *   provided (verify skipped). When passed:
 *   - non-empty string: use this tool (repository policy or non-interactive opt-in).
 *   - `null`: use user-global `default_tool` then built-in OpenCode.
 *   Never pass `undefined` as the resolution value itself — only omit the
 *   parameter when verify did not run.
 */
export function resolve_create_tool_name(
    cli_tool: string | undefined,
    loaded_configuration: Loaded_Configuration,
    per_source_override?: string | null,
): string {
    if (cli_tool !== undefined && cli_tool !== '') {
        return cli_tool;
    }

    if (per_source_override !== undefined) {
        if (per_source_override !== null && per_source_override !== '') {
            return per_source_override;
        }

        if (loaded_configuration.default_tool !== null && loaded_configuration.default_tool !== '') {
            return loaded_configuration.default_tool;
        }

        return DEFAULT_BUILTIN_TOOL;
    }

    if (loaded_configuration.default_tool !== null && loaded_configuration.default_tool !== '') {
        return loaded_configuration.default_tool;
    }

    return DEFAULT_BUILTIN_TOOL;
}

/**
 * Resolve and validate a tool provider for create. Throws if the name is unknown.
 */
export function resolve_create_tool_provider(
    cli_tool: string | undefined,
    loaded_configuration: Loaded_Configuration,
    per_source_override?: string | null,
) {
    const tool_name = resolve_create_tool_name(
        cli_tool,
        loaded_configuration,
        per_source_override,
    );
    return { tool_name, provider: get_provider(tool_name) };
}
