/**
 * Per-repository `default_tool` conflict resolution: three-way picker,
 * preference persistence, and non-interactive policy.
 */
import type { Loaded_Configuration } from '../configuration.js';
import type { Prompter } from '../prompts.js';
import { logger } from '../logger.js';
import { is_provider_registered } from './provider.js';
import {
    read_default_tool_preference,
    write_default_tool_preference,
    type Default_Tool_Choice,
} from './default_tool_preference.js';
import {
    DEFAULT_BUILTIN_TOOL,
    type Per_Source_Default_Tool_Resolution,
} from './default_tool.js';

export interface Verify_Default_Tool_Options {
    /**
     * Override the non-TTY abort for unresolved conflicts. Applies the
     * repository `default_tool` for this invocation without writing a preference.
     */
    allow_untrusted_default_tool?: boolean;
    output_warn?: (line: string) => void;
    prompter?: Prompter | null;
}

export class Default_Tool_Aborted_Error extends Error {
    constructor() {
        super('Per-source default_tool selection aborted.');
        this.name = 'Default_Tool_Aborted_Error';
    }
}

export class Default_Tool_Declined_Error extends Error {
    constructor(reason: string) {
        super(`Per-source default_tool not resolved: ${reason}`);
        this.name = 'Default_Tool_Declined_Error';
    }
}

export class Conflicting_Default_Tools_Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Conflicting_Default_Tools_Error';
    }
}

/**
 * Combine CLI flag and environment variable for non-interactive default-tool opt-in.
 */
export function resolve_allow_untrusted_default_tool_from(
    flags: { allow_untrusted_default_tool: boolean },
    env: NodeJS.ProcessEnv,
): boolean {
    return flags.allow_untrusted_default_tool || env.PATCHLAB_ALLOW_UNTRUSTED_DEFAULT_TOOL === '1';
}

function resolve_fallback_tool_name(loaded_configuration: Loaded_Configuration): string {
    if (loaded_configuration.default_tool !== null && loaded_configuration.default_tool !== '') {
        return loaded_configuration.default_tool;
    }

    return DEFAULT_BUILTIN_TOOL;
}

interface Participating_Repository {
    repository_root: string;
    tool_name: string;
}

function collect_participating_repositories(
    repository_roots: readonly string[],
    loaded_configuration: Loaded_Configuration,
): Participating_Repository[] {
    const participating: Participating_Repository[] = [];
    for (const repository_root of repository_roots) {
        const tool_name = loaded_configuration.per_repository_default_tools[repository_root];
        if (tool_name !== undefined) {
            participating.push({ repository_root, tool_name });
        }
    }

    return participating;
}

function format_conflicting_default_tools_error(participating: Participating_Repository[]): string {
    const lines = [
        'Multiple repositories declare different per-source default_tool values.',
        'Conflicting repositories:',
    ];
    for (const entry of participating) {
        lines.push(`  - ${entry.repository_root}: ${entry.tool_name}`);
    }
    lines.push(
        'Resolution: pass explicit --tool, align default_tool across repositories, '
        + 'or create from a single repository.',
    );
    return lines.join('\n');
}

function build_disclosure_lines(
    participating: Participating_Repository[],
    unanimous_tool_name: string,
    fallback_tool_name: string,
): string[] {
    const lines = [
        'Per-source default_tool conflicts with your usual tool choice.',
        `Proposed tool: ${unanimous_tool_name}`,
        `Your default without this repository: ${fallback_tool_name}`,
        '',
        'Participating repositories:',
    ];
    for (const entry of participating) {
        lines.push(`  - ${entry.repository_root}`);
    }

    lines.push('');
    return lines;
}

function write_preferences_for_participating(
    participating: Participating_Repository[],
    unanimous_tool_name: string,
    choice: Default_Tool_Choice,
): void {
    for (const entry of participating) {
        write_default_tool_preference(entry.repository_root, unanimous_tool_name, choice);
    }
}

/**
 * Resolve per-source `default_tool` when the CLI omitted `--tool`.
 *
 * Returns `{ override: string }` to use the repository tool, or `{ override: null }`
 * to use user-global / built-in fallback. Throws on abort, non-interactive decline,
 * conflicting multi-repo values, or unknown tool names.
 */
export async function verify_per_source_default_tool(
    repository_roots: readonly string[],
    loaded_configuration: Loaded_Configuration,
    options?: Verify_Default_Tool_Options,
): Promise<Per_Source_Default_Tool_Resolution> {
    const participating = collect_participating_repositories(repository_roots, loaded_configuration);
    if (participating.length === 0) {
        return { override: null };
    }

    const unique_tool_names = [...new Set(participating.map((entry) => entry.tool_name))];
    if (unique_tool_names.length > 1) {
        throw new Conflicting_Default_Tools_Error(format_conflicting_default_tools_error(participating));
    }

    const unanimous_tool_name = unique_tool_names[0];
    const fallback_tool_name = resolve_fallback_tool_name(loaded_configuration);
    if (unanimous_tool_name === fallback_tool_name) {
        return { override: null };
    }

    if (!is_provider_registered(unanimous_tool_name)) {
        throw new Error(
            `Unknown tool '${unanimous_tool_name}' in per-source default_tool. `
            + 'Register the provider or fix the configuration before creating a sandbox.',
        );
    }

    const is_multi_repository = participating.length > 1;
    if (!is_multi_repository) {
        const repository_root = participating[0].repository_root;
        const stored = read_default_tool_preference(repository_root);
        if (stored !== null && stored.value === unanimous_tool_name) {
            if (stored.choice === 'repository') {
                return { override: unanimous_tool_name };
            }

            if (stored.choice === 'fallback') {
                return { override: null };
            }
        }
    }

    const prompter = options?.prompter ?? null;
    const allow_untrusted = options?.allow_untrusted_default_tool ?? false;
    const warn = options?.output_warn ?? ((line: string) => logger().warn(line));

    if (prompter === null) {
        if (allow_untrusted) {
            return { override: unanimous_tool_name };
        }

        for (const line of build_disclosure_lines(participating, unanimous_tool_name, fallback_tool_name)) {
            warn(line);
        }
        warn(
            'Non-interactive context: pass --tool or --allow-untrusted-default-tool '
            + '(or PATCHLAB_ALLOW_UNTRUSTED_DEFAULT_TOOL=1) to proceed.',
        );
        throw new Default_Tool_Declined_Error(
            'non-interactive context without --allow-untrusted-default-tool',
        );
    }

    for (const line of build_disclosure_lines(participating, unanimous_tool_name, fallback_tool_name)) {
        logger().warn(line);
    }

    const choose_labels = [
        `Use this repository's default_tool (${unanimous_tool_name})`,
        `Use your default (${fallback_tool_name})`,
    ];
    const choice_index = await prompter.choose(
        'Which default tool should patchlab use? ',
        choose_labels,
        { cancel_label: 'Abort' },
    );

    if (choice_index === null) {
        throw new Default_Tool_Aborted_Error();
    }

    if (choice_index === 0) {
        write_preferences_for_participating(participating, unanimous_tool_name, 'repository');
        return { override: unanimous_tool_name };
    }

    if (choice_index === 1) {
        write_preferences_for_participating(participating, unanimous_tool_name, 'fallback');
        return { override: null };
    }

    throw new Default_Tool_Aborted_Error();
}
