/**
 * Tests for per-source default_tool conflict resolution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    verify_per_source_default_tool,
    Default_Tool_Aborted_Error,
    Default_Tool_Declined_Error,
    Conflicting_Default_Tools_Error,
    resolve_allow_untrusted_default_tool_from,
} from '../../../src/tools/default_tool_trust.js';
import {
    read_default_tool_preference,
    write_default_tool_preference,
} from '../../../src/tools/default_tool_preference.js';
import { loaded_configuration_with_resource_limits } from '../../../src/configuration.js';
import { register_provider } from '../../../src/tools/provider.js';
import { OPENCODE_TOOL_NAME } from '../../../src/opencode/index.js';
import { logger } from '../../../src/logger.js';
import { make_stub_tool_provider } from '../../helpers/stub_tool_provider.js';
import type { Prompter } from '../../../src/prompts.js';

function inline_prompter(
    choose: (
        message: string,
        options: string[],
        choose_options?: { cancel_label?: string },
    ) => Promise<number | null>,
): Prompter {
    return {
        confirm: async () => { throw new Error('confirm unused'); },
        choose: choose,
    };
}

let patchlab_home: string;
let repository_a: string;
let repository_b: string;
let original_patchlab_home: string | undefined;

beforeEach(() => {
    original_patchlab_home = process.env.PATCHLAB_HOME;
    patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-default-tool-trust-'));
    repository_a = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-repo-a-'));
    repository_b = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-repo-b-'));
    process.env.PATCHLAB_HOME = patchlab_home;
    register_provider(make_stub_tool_provider('team-tool'));
});

afterEach(() => {
    if (original_patchlab_home === undefined) {
        delete process.env.PATCHLAB_HOME;
    } else {
        process.env.PATCHLAB_HOME = original_patchlab_home;
    }

    fs.rmSync(patchlab_home, { recursive: true, force: true });
    fs.rmSync(repository_a, { recursive: true, force: true });
    fs.rmSync(repository_b, { recursive: true, force: true });
});

describe('verify_per_source_default_tool', () => {
    it('returns null override when no repository sets default_tool', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null);
        const result = await verify_per_source_default_tool([repository_a], loaded);
        expect(result.override).toBeNull();
    });

    it('returns null override when per-source matches user-global fallback', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'team-tool',
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        const result = await verify_per_source_default_tool([repository_a], loaded);
        expect(result.override).toBeNull();
    });

    it('short-circuits from stored repository preference on single-repo create', async () => {
        write_default_tool_preference(repository_a, 'team-tool', 'repository');
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        const result = await verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => { throw new Error('should not prompt'); }),
        });
        expect(result.override).toBe('team-tool');
    });

    it('re-prompts when stored preference value is stale', async () => {
        write_default_tool_preference(repository_a, 'old-tool', 'repository');
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        let prompted = false;
        const result = await verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => {
                prompted = true;
                return 0;
            }),
        });
        expect(prompted).toBe(true);
        expect(result.override).toBe('team-tool');
        const stored = read_default_tool_preference(repository_a);
        expect(stored?.value).toBe('team-tool');
    });

    it('short-circuits from stored fallback preference on single-repo create', async () => {
        write_default_tool_preference(repository_a, 'team-tool', 'fallback');
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'shell',
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        const result = await verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => { throw new Error('should not prompt'); }),
        });
        expect(result.override).toBeNull();
    });

    it('prompts and writes repository choice', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        const result = await verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => 0),
        });
        expect(result.override).toBe('team-tool');
        const stored = read_default_tool_preference(repository_a);
        expect(stored?.choice).toBe('repository');
    });

    it('prompts and writes fallback choice', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        const result = await verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => 1),
        });
        expect(result.override).toBeNull();
        const stored = read_default_tool_preference(repository_a);
        expect(stored?.choice).toBe('fallback');
    });

    it('throws when user aborts the picker', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        await expect(verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => null),
        })).rejects.toThrow(Default_Tool_Aborted_Error);
        expect(read_default_tool_preference(repository_a)).toBeNull();
    });

    it('throws for unknown tool before prompting', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'not-registered-ever' },
        });
        let choose_called = false;
        await expect(verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async () => {
                choose_called = true;
                return 0;
            }),
        })).rejects.toThrow(/Unknown tool 'not-registered-ever'/);
        expect(choose_called).toBe(false);
    });

    it('aborts in non-interactive context without opt-in', async () => {
        const warnings: string[] = [];
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        await expect(verify_per_source_default_tool([repository_a], loaded, {
            prompter: null,
            output_warn: (line) => warnings.push(line),
        })).rejects.toThrow(Default_Tool_Declined_Error);
        expect(warnings.some((line) => line.includes('Non-interactive'))).toBe(true);
    });

    it('applies repository tool without writing preference when opt-in is set', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        const result = await verify_per_source_default_tool([repository_a], loaded, {
            prompter: null,
            allow_untrusted_default_tool: true,
        });
        expect(result.override).toBe('team-tool');
        expect(read_default_tool_preference(repository_a)).toBeNull();
    });

    it('does not opt in from manifest-trust env vars alone', async () => {
        const previous_manifest_opt_in = process.env.PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS;
        const previous_strict = process.env.PATCHLAB_STRICT_TRUST;
        process.env.PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS = '1';
        process.env.PATCHLAB_STRICT_TRUST = '1';

        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        await expect(verify_per_source_default_tool([repository_a], loaded, {
            prompter: null,
        })).rejects.toThrow(Default_Tool_Declined_Error);

        if (previous_manifest_opt_in === undefined) {
            delete process.env.PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS;
        } else {
            process.env.PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS = previous_manifest_opt_in;
        }
        if (previous_strict === undefined) {
            delete process.env.PATCHLAB_STRICT_TRUST;
        } else {
            process.env.PATCHLAB_STRICT_TRUST = previous_strict;
        }
    });

    it('opt-in cannot resolve conflicting multi-repository default_tool values', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: {
                [repository_a]: 'team-tool',
                [repository_b]: OPENCODE_TOOL_NAME,
            },
        });
        await expect(verify_per_source_default_tool(
            [repository_a, repository_b],
            loaded,
            { prompter: null, allow_untrusted_default_tool: true },
        )).rejects.toThrow(Conflicting_Default_Tools_Error);
    });

    it('throws when multiple repositories declare different default_tool values', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: {
                [repository_a]: 'team-tool',
                [repository_b]: OPENCODE_TOOL_NAME,
            },
        });
        await expect(verify_per_source_default_tool(
            [repository_a, repository_b],
            loaded,
        )).rejects.toThrow(Conflicting_Default_Tools_Error);
    });

    it('ignores stored preferences on multi-repository create and prompts', async () => {
        write_default_tool_preference(repository_a, 'team-tool', 'repository');
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: {
                [repository_a]: 'team-tool',
                [repository_b]: 'team-tool',
            },
        });
        let prompted = false;
        const result = await verify_per_source_default_tool(
            [repository_a, repository_b],
            loaded,
            {
                prompter: inline_prompter(async () => {
                    prompted = true;
                    return 0;
                }),
            },
        );
        expect(prompted).toBe(true);
        expect(result.override).toBe('team-tool');
    });

    it('writes repository choice to every participating repository on multi-repo create', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: {
                [repository_a]: 'team-tool',
                [repository_b]: 'team-tool',
            },
        });
        await verify_per_source_default_tool(
            [repository_a, repository_b],
            loaded,
            { prompter: inline_prompter(async () => 1) },
        );
        expect(read_default_tool_preference(repository_a)?.choice).toBe('fallback');
        expect(read_default_tool_preference(repository_b)?.choice).toBe('fallback');
    });

    it('discloses every participating repository path on multi-repo create', async () => {
        const warnings: string[] = [];
        const warn_spy = vi.spyOn(logger(), 'warn').mockImplementation((message: string | Error) => {
            warnings.push(typeof message === 'string' ? message : message.message);
        });
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: {
                [repository_a]: 'team-tool',
                [repository_b]: 'team-tool',
            },
        });
        await verify_per_source_default_tool(
            [repository_a, repository_b],
            loaded,
            { prompter: inline_prompter(async () => 0) },
        );
        expect(warnings.some((line) => line.includes(repository_a))).toBe(true);
        expect(warnings.some((line) => line.includes(repository_b))).toBe(true);
        warn_spy.mockRestore();
    });

    it('passes cancel_label Abort to the prompter choose call', async () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        let captured_cancel_label: string | undefined;
        await verify_per_source_default_tool([repository_a], loaded, {
            prompter: inline_prompter(async (_message, _options, choose_options) => {
                captured_cancel_label = choose_options?.cancel_label;
                return 0;
            }),
        });
        expect(captured_cancel_label).toBe('Abort');
    });

    it('treats one-repo-with-default as single-repo when the other omits default_tool', async () => {
        write_default_tool_preference(repository_a, 'team-tool', 'repository');
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            per_repository_default_tools: { [repository_a]: 'team-tool' },
        });
        let prompted = false;
        const result = await verify_per_source_default_tool(
            [repository_a, repository_b],
            loaded,
            {
                prompter: inline_prompter(async () => {
                    prompted = true;
                    return 0;
                }),
            },
        );
        expect(prompted).toBe(false);
        expect(result.override).toBe('team-tool');
    });
});

describe('resolve_allow_untrusted_default_tool_from', () => {
    it('reads CLI flag and environment variable', () => {
        expect(resolve_allow_untrusted_default_tool_from(
            { allow_untrusted_default_tool: true },
            {},
        )).toBe(true);
        expect(resolve_allow_untrusted_default_tool_from(
            { allow_untrusted_default_tool: false },
            { PATCHLAB_ALLOW_UNTRUSTED_DEFAULT_TOOL: '1' },
        )).toBe(true);
    });
});
