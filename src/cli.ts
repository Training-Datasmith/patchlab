#!/usr/bin/env node
import * as path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { apply_snake_case_option_naming } from './cli_option_naming.js';
import {
    list_sandboxes,
    inspect_sandbox,
    destroy_sandbox,
    garbage_collect_sandboxes,
    create_sandbox,
    resume_sandbox,
    type Garbage_Collection_Options,
    type Orphan_Branch_Outcome,
} from './sandbox/index.js';
import {
    parse_copy_specification,
    parse_session_number,
    resolve_apply_mode,
    validate_mount_count,
} from './cli_arguments.js';
import { diff_sandbox } from './changes.js';
import { format_list_header, format_list_row } from './cli_list.js';
import { generate_patch, generate_session_patch, write_patch } from './patches.js';
import {
    apply_patchlab_branch,
    commit_session_to_branch,
    patchlab_branch_name,
    record_extraction_outcome,
    resolve_apply_repository,
    type Apply_Result,
} from './branch/index.js';
import { assert_valid_patchlab_id, build_archive_path, build_session_path, get_repository_root, read_session_metadata, next_session_number } from './archive.js';
import { distinct_repositories_from_sources, manifest_primary_source, manifest_repositories, read_manifest, resolve_manifest_tool, type Sandbox_Manifest } from './manifest.js';
import { resolve_source_inputs, expand_manifest_sources } from './sources.js';
import { extract_history, extract_conversation, finalize_session_metadata } from './extraction.js';
import { exec_interactive, ensure_podman } from './podman.js';
import { ensure_default_image } from './auto_build.js';
import {
    get_provider,
    validate_user_global_or_abort,
    register_per_source_manifests,
    compute_container_workspace_path,
} from './tools/index.js';
import { run_list_tools } from './list_tools.js';
import {
    verify_per_source_trust_multi_repository,
    is_per_source_unconfirmed,
    resolve_trust_options_from,
    type Confirm_Per_Source_Options,
} from './tools/configured_provider/trust_verification.js';
import { build_image, list_images } from './images.js';
import { detect_project } from './languages/index.js';
import { detect_requirements, type Detected_Requirements } from './detect/index.js';
import { load_overrides, load_sources_from_manifest } from './overrides.js';
import { merge_requirements } from './overrides_merge.js';
import { type Prompter } from './prompts.js';
import { resolve_runtime_prompter } from './cli_prompter.js';
import { format_bytes } from './format.js';
import { logger, set_cli_verbose_override, argv_contains_verbose_flag } from './logger.js';
import {
    argv_contains_resource_flag_negative,
    parse_memory_value,
    parse_cpus_value,
    parse_pids_value,
    parse_blkio_weight_value,
    type CLI_Limit_Overrides,
} from './resource_limits.js';
import { load_configuration } from './configuration.js';
import { extract_workspace_copies, type Copy_Specification } from './sandbox/workspace_copies.js';

// =========================================================================
// Prompt-site audit (structural lock for the isolate-cli-prompter change).
//
// Every interactive prompt this file issues — direct or via a closure passed
// to a library callback — must route through a `Prompter | null` constructed
// by `resolve_runtime_prompter()`. There is exactly one `Prompter` per
// command action (or per `preAction` invocation); the library callback
// signatures are NOT changed. A future contributor adding a new prompt site
// MUST add an entry to this audit and thread an existing or new prompter.
//
// `preAction` hook → `ensure_podman(prompter)` (machine-reset confirm)
//
// `create` action handler:
//   - `create_sandbox(..., { prompter })` → dirty-tree, submodule, socket-
//     mount, service, and trust confirms (all inside the library now)
//   - `run_branch_commit_step(..., prompter)` → `confirm_oversized` closure
//     calls `prompter.confirm` (oversized session diff)
//
// `resume` action handler:
//   - `resolve_trust_options(prompter)` → `trust_options.prompter` →
//     `confirm_per_source_manifests`
//   - `resume_sandbox(..., { prompter })` → active-sandbox and oversized-
//     archive confirms (inside the library now)
//   - `extract_session_to_branch(..., prompter)` → `run_branch_commit_step`
//
// `destroy` action handler:
//   - `destroy_sandbox.confirm` closure → `prompter.confirm` (force-delete)
//
// `gc` action handler:
//   - Direct top-level `prompter?.confirm(...)` (remove-N-sandboxes prompt)
//   - `build_orphan_branch_confirm(options.force, prompter)` → per-orphan
//     `prompter.confirm`
//
// Read-only / no-prompt actions (`list`, `inspect`, `list-tools`, `apply`,
// the `--help` path) do NOT construct a prompter — their library calls do
// not reach any prompt site.
// =========================================================================

function require_cli_tool_name(tool: string | undefined, command: string): string {
    if (tool === undefined || tool === '') {
        logger().error(
            `${command}: --tool is required. `
            + 'Configure a provider under ~/.patchlab/tools/ or <source>/.patchlab/tools/, '
            + 'then run `patchlab list-tools` to see available names.',
        );
        process.exit(1);
    }

    return tool;
}

/**
 * Run the full sandbox-exit extraction in spec order:
 *   1. History (git log + bash history)
 *   2. Conversation (provider artifacts)
 *   3. Branch commit (`patchlab-branches`)
 *   4. Session metadata finalize (read-modify-write)
 *
 * Each step is best-effort up through commit; if commit fails catastrophically,
 * the session is marked `interrupted` so prior captures are preserved.
 */
async function extract_session_to_branch(
    manifest: Sandbox_Manifest,
    working_directory: string,
    prompter: Prompter | null,
): Promise<void> {
    const session_number = next_session_number(manifest.id) - 1;
    const primary_repository = manifest_primary_source(manifest).repository_root;
    const meta = read_session_metadata(manifest.id, session_number);
    if (!meta) {
        logger().warn('Session metadata missing; cannot extract session. Skipping.');
        return;
    }

    const tool_name = resolve_manifest_tool(manifest);
    const provider = get_provider(tool_name);

    // extract_workspace_copies handles per-file failures internally (warns and
    // continues). This outer catch is a last-resort guard against unexpected
    // throws (e.g. a filesystem permission error on the archive root itself)
    // that would otherwise abort the entire extraction sequence.
    try {
        extract_workspace_copies(
            manifest.container_name,
            provider.image_specification.image_home,
            build_session_path(manifest.id, session_number, 'workspace-copies'),
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: workspace copy-out failed — ${message}. Continuing.`);
    }

    const extraction_outcome = run_best_effort_history_and_conversation(
        manifest.container_name,
        working_directory,
        provider,
        manifest.id,
        session_number
    );

    const commit_outcome = await run_branch_commit_step(
        manifest,
        tool_name,
        working_directory,
        meta.created_at,
        session_number,
        prompter,
    );

    if (commit_outcome.result) {
        record_commit_sha_with_recovery_message(manifest.id, session_number, primary_repository, commit_outcome.result);
        log_commit_outcome(manifest.id, session_number, primary_repository, commit_outcome.result);
    }

    const final_status = (
        commit_outcome.status === 'interrupted' || extraction_outcome.lost_data
    ) ? 'interrupted' : 'completed';
    finalize_session_metadata(manifest.id, session_number, final_status);
}

/**
 * Best-effort wrapper around history and conversation extraction. Returns a
 * `lost_data` flag — true when the extraction reported `produced_but_failed`
 * artifacts OR when extraction itself threw. The status finalizer treats
 * either case as `'interrupted'` because lost data takes precedence over
 * commit success per the patchlab-archive `Sandbox exit extraction ordering`
 * requirement.
 *
 * `skipped_invalid` artifacts (validator/uniqueness/type-check rejections) do
 * NOT contribute to `lost_data` — those represent buggy provider declarations,
 * not lost data, and the session is still safely resumable.
 */
function run_best_effort_history_and_conversation(
    container_name: string,
    working_directory: string,
    provider: ReturnType<typeof get_provider>,
    patchlab_id: string,
    session_number: number
): { lost_data: boolean } {
    // History and conversation are best-effort: if either throws, log and continue so
    // the branch commit (which carries the user's actual code changes) still runs.
    try {
        extract_history(
            container_name,
            working_directory,
            provider.image_specification.image_home,
            patchlab_id,
            session_number
        );
    } catch (error) {
        // History (git log + bash history) deliberately does NOT contribute
        // to `lost_data`: a missing or partial history is recoverable from
        // the host's own `git log` and the loss is bounded to a single shell
        // session. Conversation (below) is irreplaceable, so it does.
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: history extraction failed — ${message}. Continuing.`);
    }

    try {
        const result = extract_conversation(container_name, provider, patchlab_id, session_number);
        return { lost_data: result.produced_but_failed.length > 0 };
    } catch (error) {
        // Throw is treated as "every declared artifact failed" — we cannot tell
        // whether the throw left some artifacts partially copied, so the safe
        // assumption is lost data.
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: conversation extraction failed — ${message}. Continuing.`);

        return { lost_data: true };
    }
}

interface Commit_Outcome {
    status: 'completed' | 'interrupted';
    result: Awaited<ReturnType<typeof commit_session_to_branch>> | null;
}

async function run_branch_commit_step(
    manifest: { id: string; container_name: string },
    tool_name: string,
    working_directory: string,
    created_at: string,
    session_number: number,
    prompter: Prompter | null,
): Promise<Commit_Outcome> {
    try {
        const result = await commit_session_to_branch(manifest.id, session_number, {
            container_name: manifest.container_name,
            workspace: working_directory,
            tool_name,
            created_at,
            author_name: 'patchlab',
            author_email: 'patchlab@local',
            confirm_oversized: async (size_bytes) => {
                logger().warn(
                    `Session diff is ${format_bytes(size_bytes)} — larger than the default cap. `
                    + `Transferring it from the sandbox may take a while.`
                );

                return await (prompter?.confirm(
                    'Proceed with the auto-commit anyway? [y/N] ',
                    { default_yes: false },
                ) ?? Promise.resolve(false));
            },
        });

        return { status: 'completed', result };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: branch commit failed — ${message}. History and conversation were preserved.`);

        return { status: 'interrupted', result: null };
    }
}

/**
 * Persist commit_shas and fallback_patches together in session metadata. If the
 * metadata write fails after a successful branch commit, the commit still lives on
 * the branch — surface the SHA so the user can recover by hand.
 */
function record_commit_sha_with_recovery_message(
    patchlab_id: string,
    session_number: number,
    primary_repository: string,
    commit_result: Awaited<ReturnType<typeof commit_session_to_branch>>
): void {
    try {
        record_extraction_outcome(patchlab_id, session_number, commit_result);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const sha_label = commit_result.commit_shas[primary_repository] ?? '(no commit)';
        const fallback_label = commit_result.fallback_patches[primary_repository] ?? '(none)';
        logger().warn(
            `Warning: branch commit succeeded but session metadata write failed — ${message}.\n`
            + `Session ${session_number} commit SHA: ${sha_label}, fallback: ${fallback_label}.\n`
            + `To recover, manually set "commit_shas" and "fallback_patches" in `
            + `~/.patchlab/${patchlab_id}/sessions/${session_number}/metadata.json.`
        );
    }
}

function log_commit_outcome(
    patchlab_id: string,
    session_number: number,
    primary_repository: string,
    commit_result: Awaited<ReturnType<typeof commit_session_to_branch>>
): void {
    const commit_sha = commit_result.commit_shas[primary_repository] ?? null;
    const fallback_path = commit_result.fallback_patches[primary_repository] ?? null;
    if (commit_sha) {
        const branch = patchlab_branch_name(patchlab_id);
        logger().info(`\nSession ${session_number} committed to ${branch} as ${commit_sha.slice(0, 8)}.`);
        logger().info(`Inspect with: git log ${branch}`);
        logger().info(`Apply with: git cherry-pick ${commit_sha}`);
    } else if (fallback_path) {
        logger().info(`\nSession ${session_number}: branch was missing; diff saved to ${fallback_path}.`);
    } else {
        logger().info('\nNo changes detected in sandbox.');
    }
}

// Set the verbose-mode CLI override BEFORE Commander parses argv.
//
// Commander's subcommand action handlers execute *during* `program.parse()`.
// If `set_cli_verbose_override` were called after `parse()` returned, any
// `logger().verbose(...)` invoked inside an action handler would see the
// stale `false` value even when the user passed `--verbose`. Doing the scan
// here — before any Commander state is built — eliminates that race.
//
// `--verbose` is a reserved global option name; subcommands SHALL NOT define
// their own `--verbose` flag with a different meaning (see also the
// program-level `.option('--verbose', ...)` registration below).
if (argv_contains_verbose_flag(process.argv)) {
    set_cli_verbose_override(true);
}

// Pre-parse guard for negative resource-limit flag values.
//
// Commander parses `--pids-limit -1` (space-separated) by treating `-1` as
// a separate token that looks like a flag, producing a "missing argument"
// or "unknown option" error that does NOT clearly name the resource flag.
// This guard catches the case before Commander touches argv and emits a
// patchlab-branded error naming the offending flag. The equals form
// (`--flag=-N`) is handled by the per-flag validator after Commander
// accepts the value as a string.
{
    const negative = argv_contains_resource_flag_negative(process.argv);
    if (negative !== null) {
        // `--blkio-weight` has no `0`-as-unlimited form (valid range is
        // [10, 1000]), so the "use 0 for unlimited" hint is misleading there.
        // The other three flags accept `0` as the explicit-opt-out sentinel.
        const hint = negative.flag === '--blkio-weight'
            ? `(valid range: [10, 1000])`
            : `(use 0 for unlimited)`;
        logger().error(
            `error: ${negative.flag}: negative values are not accepted ${hint}`,
        );
        process.exit(1);
    }
}

/**
 * Wrap `load_configuration` with CLI-level error handling: on any failure
 * (oversized file, malformed YAML, schema violation, out-of-range value),
 * print a clear single-line error via `logger().error(...)` and exit with a
 * non-zero status BEFORE any sandbox/container work begins. Per task 3.3:
 * configuration loading is a pre-flight check; partial sandbox creation on
 * a bad configuration file would be worse than failing fast.
 */
function load_configuration_or_exit(repository_roots: readonly string[]): ReturnType<typeof load_configuration> {
    try {
        return load_configuration(repository_roots);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().error(`error: failed to load configuration: ${message}`);
        process.exit(1);
    }
}

// Switch Commander's option attribute keys from camelCase to snake_case BEFORE
// any command/option is registered, so parsed keys match this project's naming
// convention (e.g. `options.older_than`, not `options.olderThan`). See
// cli_option_naming.ts for the mechanism and its caveats.
apply_snake_case_option_naming();

const program = new Command();

program
    .name('patchlab')
    .description('Isolated container sandbox for creating patches')
    .version('0.1.0')
    .option('--verbose', 'enable verbose diagnostic output (also: PATCHLAB_VERBOSE env var; CLI flag wins)')
    .option(
        '--strict-trust',
        'Explicit reaffirmation of the strict-by-default non-TTY trust behavior for per-source configured providers. '
        + 'Semantically a no-op (default non-TTY behavior is already abort). Useful for scripts/configs that want to declare the trust posture. '
        + 'Also settable via PATCHLAB_STRICT_TRUST=1. Mutually exclusive with --allow-untrusted-manifests.',
    )
    .option(
        '--allow-untrusted-manifests',
        'Override the strict-by-default non-TTY abort for per-source configured providers — proceeds without prompting in non-TTY contexts. '
        + 'CI opt-in. Marker file is NOT written, so subsequent interactive runs still prompt. '
        + 'Also settable via PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS=1. Mutually exclusive with --strict-trust.',
    )
    .hook('preAction', async (_thisCommand, actionCommand) => {
        // Internal end-to-end witness for the `--verbose` and
        // `PATCHLAB_VERBOSE` plumbing. Gated by `PATCHLAB_VERBOSE_PROBE=1`
        // so it's invisible to ordinary CLI users. Emitted via
        // `logger().verbose(...)`, which silently no-ops unless verbose mode
        // is active (CLI flag or env var). Tests can therefore probe both
        // halves of the contract: that verbose state actually flips the
        // logger (positive witness) AND that the two activation paths
        // converge on identical output.
        if (process.env.PATCHLAB_VERBOSE_PROBE === '1') {
            logger().verbose('verbose-probe');
        }

        // Operational commands strictly validate user-global manifests; the
        // diagnostic `list-tools` tolerates broken manifests and renders them
        // inline (per the locked-in `list-tools reports broken manifests
        // inline` scenario).
        if (actionCommand.name() !== 'list-tools') {
            validate_user_global_or_abort();
        }

        if (actionCommand.name() !== 'apply') {
            // Single TTY-detection site for the preAction-gated commands;
            // ensure_podman threads the prompter into its private
            // start_or_recover_machine helper. See cli_prompter.ts.
            await ensure_podman(resolve_runtime_prompter());
        }
    });

function resolve_trust_options(prompter: Prompter | null): Confirm_Per_Source_Options {
    const program_options = program.opts() as { strict_trust?: boolean; allow_untrusted_manifests?: boolean };
    const base = resolve_trust_options_from(
        {
            strict_trust: program_options.strict_trust === true,
            allow_untrusted: program_options.allow_untrusted_manifests === true,
        },
        process.env,
    );

    return { ...base, prompter };
}

program
    .command('create')
    .description('Create a new patchlab from one or more source directories, optionally spanning multiple git repositories')
    .argument('[source]', 'Primary source directory path (positional). When omitted, sources are read from the `sources` array in .patchlab.json (searched in the current working directory first, then the git root of the CWD).')
    .option('--source <path>', 'Additional source directory; repeatable. Each value adds a mount under ${HOME}/workspace/<mount_name>/. Sources MAY span multiple git repositories; when they do, every source (including the primary) MUST be supplied with an explicit --mount <name>.', collect_repeatable_source, [] as string[])
    .option('--mount <name>', 'Container-side mount directory name for the corresponding source; repeatable. The Nth --mount applies to the Nth source in order (0 = primary positional, 1 = first --source, etc.). Required for every source in a multi-repository create; optional for single-repository (defaults to the source\'s relative path within its repository).', collect_repeatable_source, [] as string[])
    .option('--include <globs...>', 'Glob patterns to include')
    .option('--exclude <globs...>', 'Glob patterns to exclude')
    .option('--image <image>', 'Container image to use (default: node:22-slim)')
    .option('--no-install', 'Skip automatic npm install')
    .option('--force-rebuild', 'Force fresh image build, ignoring cached images')
    .option('--allow-socket-mount', 'Allow socket mount without prompting')
    .option('--deny-socket-mount', 'Deny socket mount without prompting')
    .option('--allow-submodules', 'Proceed when any source repository contains git submodules (submodule contents are treated as regular files; apply conflicts may result)')
    .option('--allow-dirty-tree', 'Proceed when the host working tree is dirty (uncommitted changes are captured as a labeled baseline commit on the patchlab branch)')
    .option('--tool <name>', 'AI coding tool to use (required). Accepts user-global configured providers from ~/.patchlab/tools/*.yaml and per-source configured providers from <repository_root>/.patchlab/tools/*.yaml (subject to host-path containment and a first-encounter trust prompt — see --strict-trust / --allow-untrusted-manifests and documents/configuration-based-providers.md). Run `patchlab list-tools` to see available providers')
    .option('--no-interactive', 'Skip interactive AI tool launch (for scripts/tests)')
    .option('--context <paths...>', 'Files or directories to inject into $HOME/context/ in the sandbox')
    .option('--copy <source[:destination]>', 'Copy a host file or directory into the sandbox workspace (repeatable; secret-pattern files are not blocked but a warning is emitted)',
        (value, previous: Copy_Specification[]) => previous.concat([parse_copy_specification(value)]), [] as Copy_Specification[])
    .option('--include-secrets', 'Include common secret-pattern files (.env, *.pem, *.key, SSH keys, etc.) — disabled by default')
    .option('--composer-path-repositories', 'Scan each source\'s composer.json for a name field, cross-reference against other sources\' require/require-dev entries, and configure matches as composer path repositories in the sandbox\'s global composer configuration')
    .option('--memory <value>', 'Memory limit (e.g. 4g, 512m); 0 = unlimited', parse_memory_value)
    .option('--cpus <value>', 'CPU limit as a decimal (e.g. 2.0); 0 = unlimited', parse_cpus_value)
    .option('--pids-limit <value>', 'Maximum number of processes; 0 = unlimited', parse_pids_value)
    .option('--blkio-weight <value>', 'Block I/O weight in [10, 1000]', parse_blkio_weight_value)
    .action(handle_create_command);

/**
 * Implementation of the `patchlab create` subcommand. Exported so unit tests
 * can drive multi-source resolution, per-source trust registration, capability
 * detection, and the post-create interactive-launch + extract handoff without
 * spawning the CLI.
 */
export async function handle_create_command(
    source: string | undefined,
    options: {
        source?: string[];
        mount?: string[];
        include?: string[];
        exclude?: string[];
        image?: string;
        install?: boolean;
        force_rebuild?: boolean;
        allow_socket_mount?: boolean;
        deny_socket_mount?: boolean;
        allow_submodules?: boolean;
        allow_dirty_tree?: boolean;
        interactive?: boolean;
        tool?: string;
        context?: string[];
        copy?: Copy_Specification[];
        include_secrets?: boolean;
        composer_path_repositories?: boolean;
        memory?: CLI_Limit_Overrides['memory_limit'];
        cpus?: CLI_Limit_Overrides['cpu_limit'];
        pids_limit?: CLI_Limit_Overrides['pids_limit'];
        blkio_weight?: CLI_Limit_Overrides['blkio_weight'];
    },
): Promise<void> {
    // Single prompter for this command action; threaded into every
    // prompt-issuing call site below. See cli_prompter.ts.
    const prompter = resolve_runtime_prompter();
    const tool_name = require_cli_tool_name(options.tool, 'patchlab create');
    // Resolve sources into validated `Source_Specification[]`. Two paths:
    //
    // CLI path: any of the positional <source>, --source, or --mount flags
    // were provided. Sources come from the command line; .patchlab.json
    // `sources` field is ignored entirely. The Nth --mount applies to the
    // Nth source positionally (0 = primary).
    //
    // Manifest path: no source-related CLI argument was provided. Sources
    // are loaded from the `sources` array in .patchlab.json, discovered in
    // the CWD first, then the git root of the CWD. String entries derive
    // their mount name from the entry path; object entries carry an explicit
    // mount name. All are treated as explicit for multi-repository validation.
    //
    // Throws on mount-explicitness, prefix-uniqueness, empty-prefix
    // exclusivity, and nested-prefix overlap violations BEFORE any container
    // or branch work.
    const additional_sources = options.source ?? [];
    const mounts = options.mount ?? [];
    const has_cli_sources = source !== undefined || additional_sources.length > 0 || mounts.length > 0;

    let sources;
    if (has_cli_sources) {
        if (source === undefined) {
            logger().error(
                'patchlab create: a positional <source> path is required when --source or --mount flags are used.',
            );
            process.exit(1);
        }

        const total_sources = 1 + additional_sources.length;
        validate_mount_count(mounts.length, total_sources);

        const inputs = [source, ...additional_sources].map((host_path, index) => ({
            host_path,
            mount_name: index < mounts.length ? mounts[index] : undefined,
        }));
        sources = resolve_source_inputs(inputs[0], inputs.slice(1));
    } else {
        const discovered = load_sources_from_manifest(process.cwd());
        if (discovered === undefined) {
            logger().error(
                'patchlab create: no sources specified. '
                + 'Provide a source path as a positional argument, or add a "sources" array to .patchlab.json '
                + 'in the current directory (or its git root).',
            );
            process.exit(1);
        }

        const inputs = expand_manifest_sources(discovered.entries, discovered.base_directory);
        sources = resolve_source_inputs(inputs[0], inputs.slice(1));
    }
    // Positive marker emitted whenever source resolution succeeded. Tests
    // that verify NEGATIVE absence-of-rejection conditions on multi-source
    // input rely on this line to distinguish "validator passed" from
    // "validator never ran" (e.g., the subprocess crashed earlier).
    // Emitted BEFORE `ensure_default_image` so the marker appears even
    // when the test environment lacks a cached default image (and avoids
    // tying the test runtime to a multi-minute image build).
    logger().info(`Resolved ${sources.length} source(s).`);
    // Per-source registration MUST run before the first `get_provider`
    // lookup — otherwise a `--tool <name>` referring to a per-source
    // manifest would fail with "unknown tool". Trust is also verified UP FRONT
    // (before the image build); `create_sandbox` calls register + verify again
    // internally (idempotent — marker already written, so no re-prompt). Marker
    // keys on the repository root, not on any individual source.
    const trust_options = resolve_trust_options(prompter);
    // Distinct repository roots across the source set — the trust marker,
    // per-source registration, and configuration loading all key on repository
    // roots (not individual sources), so compute the set once.
    const distinct_repositories = distinct_repositories_from_sources(sources);
    const registration_result = register_per_source_manifests(
        distinct_repositories,
    );
    const provider = get_provider(tool_name);
    const primary_host_path = sources[0].host_path;
    // Verify per-source manifest trust BEFORE building any image. A per-source
    // provider's `dockerfile.install` lines run as `RUN` directives during
    // `ensure_default_image`'s `podman build`, and the trust prompt discloses
    // exactly those install commands (and the base_image) for the user to
    // approve — so the build must NOT run ahead of the prompt. `create_sandbox`
    // also calls register + verify internally (for non-CLI callers); both calls
    // are idempotent — the marker is already written, so the prompt is skipped.
    await verify_per_source_trust_multi_repository(
        distinct_repositories,
        registration_result.manifest_buffers,
        registration_result.registered_manifests,
        registration_result.registered_manifest_repositories,
        registration_result.errors,
        trust_options,
    );
    const image = options.image ?? await ensure_default_image(primary_host_path, tool_name);
    if (!options.image) {
        logger().info(`Using image: ${image}`);
    }

    const cli_resource_overrides: CLI_Limit_Overrides = {
        memory_limit: options.memory,
        cpu_limit: options.cpus,
        pids_limit: options.pids_limit,
        blkio_weight: options.blkio_weight,
    };

    // Load both configuration files once per invocation; thread the
    // result through to create_sandbox so the resolver can apply the
    // user-global and per-source-clamped layers. Load errors abort with
    // a non-zero exit BEFORE any sandbox/container work begins. The
    // per-source configuration file lives under repository_root, not
    // under any individual source path.
    const loaded_configuration = load_configuration_or_exit(
        distinct_repositories,
    );

    const manifest = await create_sandbox(sources, {
        include: options.include,
        exclude: options.exclude,
        image,
        tool: tool_name,
        no_install: options.install === false,
        force_rebuild: options.force_rebuild,
        allow_socket_mount: options.allow_socket_mount,
        deny_socket_mount: options.deny_socket_mount,
        allow_submodules: options.allow_submodules,
        allow_dirty_tree: options.allow_dirty_tree,
        context_paths: options.context,
        copy_paths: options.copy,
        include_secret_files: options.include_secrets,
        composer_path_repositories: options.composer_path_repositories,
        cli_resource_overrides,
        loaded_configuration,
        prompter,
        strict_trust: trust_options.strict_trust,
        allow_untrusted_manifests: trust_options.allow_untrusted_manifests,
    });
    logger().info(`Patchlab created: ${manifest.id}`);
    logger().info(`Container: ${manifest.container_name}`);
    logger().info(`Branch: ${patchlab_branch_name(manifest.id)}`);
    logger().info(`Image: ${manifest.container_image}\n`);

    if (options.interactive === false) {
        return;
    }

    const working_directory = compute_container_workspace_path(provider);
    try {
        exec_interactive(manifest.container_name, provider.get_launch_command(), working_directory);
    } catch (error) {
        const code = error instanceof Error && 'status' in error
            ? (error as { status?: number }).status
            : undefined;
        const suffix = code ? ' with code ' + code : '';
        logger().info('Shell exited' + suffix + '.');
    }

    // Auto-extract: commit changes to the patchlab branch.
    await extract_session_to_branch(manifest, working_directory, prompter);
}

program
    .command('list')
    .alias('list-sandboxes')
    .description('List all active sandboxes')
    .action(handle_list_command);

/** Implementation of the `patchlab list` subcommand. Exported for unit testing. */
export function handle_list_command(): void {
    const sandboxes = list_sandboxes();
    if (sandboxes.length === 0) {
        logger().info('No active sandboxes.');
        return;
    }
    logger().result(format_list_header());
    for (const sandbox of sandboxes) {
        logger().result(format_list_row(sandbox));
    }
}

program
    .command('inspect')
    .description('Inspect a patchlab')
    .argument('<patchlab>', 'Patchlab identifier')
    .action(handle_inspect_command);

/** Implementation of the `patchlab inspect` subcommand. Exported for unit testing. */
export function handle_inspect_command(sandbox_id: string): void {
    assert_valid_patchlab_id(sandbox_id);
    const details = inspect_sandbox(sandbox_id);
    logger().result(JSON.stringify(details, null, 2));
}

program
    .command('destroy')
    .description('Destroy a patchlab: container, archive, and patchlab branch in every repository the patchlab spans')
    .argument('<sandbox>', 'Patchlab identifier')
    .option('--force', 'Force-delete every repository\'s patchlab branch even if any has unapplied commits')
    .action(handle_destroy_command);

/**
 * Implementation of the `patchlab destroy` subcommand. Exported so unit tests
 * can drive the per-repository outcome reporting and unapplied-commits
 * confirmation callback without spawning the CLI.
 */
export async function handle_destroy_command(
    sandbox_id: string,
    options: { force?: boolean },
): Promise<void> {
    assert_valid_patchlab_id(sandbox_id);
    const prompter = resolve_runtime_prompter();
    const result = await destroy_sandbox(sandbox_id, {
        force: options.force,
        confirm: async (repository_root: string, count: number) => {
            logger().warn(
                `Patchlab branch in ${repository_root} has ${count} session commit(s) not applied to any other branch.`
            );
            return await (prompter?.confirm('Force-delete the branch anyway? [y/N] ') ?? Promise.resolve(false));
        },
    });
    const outcome_keys = Object.keys(result.branch_outcomes);
    if (outcome_keys.length <= 1) {
        // Single-repository (or unreadable-manifest) destroy retains
        // the legacy single-line message for backwards-compatibility.
        logger().info(`Patchlab destroyed: ${sandbox_id}`);
        return;
    }

    // Multi-repository destroy: enumerate per-repository outcomes.
    logger().info(`Patchlab ${sandbox_id} destroy outcomes:`);
    for (const [repository_root, outcome] of Object.entries(result.branch_outcomes)) {
        logger().info(`  ${repository_root}: ${outcome}`);
    }

    if (result.archive_removed) {
        logger().info('Archive directory removed.');
    } else {
        logger().warn(
            `Archive directory retained at ~/.patchlab/${sandbox_id}/. `
            + `Re-run \`patchlab destroy ${sandbox_id} --force\` to clear skipped branches, `
            + `or manually run \`git branch -D patchlab/${sandbox_id}\` in each skipped repository.`
        );
    }
}

program
    .command('diff')
    .description('Show changed files in a patchlab')
    .argument('<patchlab>', 'Patchlab identifier')
    .action(handle_diff_command);

/** Implementation of the `patchlab diff` subcommand. Exported for unit testing. */
export function handle_diff_command(sandbox_id: string): void {
    assert_valid_patchlab_id(sandbox_id);
    const changes = diff_sandbox(sandbox_id);
    if (changes.length === 0) {
        logger().info('No changes detected.');
        return;
    }
    for (const change of changes) {
        let prefix: string;
        if (change.type === 'add') {
            prefix = '+';
        } else if (change.type === 'delete') {
            prefix = '-';
        } else {
            prefix = '~';
        }
        logger().result(`${prefix} ${change.relative_path}`);
    }
}

program
    .command('patch')
    .description('Generate a patchlab diff from the patchlab branch')
    .argument('<patchlab>', 'Patchlab identifier')
    .option('--session <number>', 'Export only the given session', parse_session_number)
    .option('--repository <path>', 'Scope the diff to one host repository. Optional for single-repository patchlabs (defaults to the only repository). Omit on a multi-repository patchlab to emit each repository\'s diff in turn, separated by `# === Patch for <repository_root> ===` comment headers.')
    .option('-o, --output <file>', 'Write the diff to a file instead of stdout')
    .action(handle_patch_command);

/**
 * Implementation of the `patchlab patch` subcommand. Exported so unit tests
 * can drive the per-session vs cumulative branches and the file-output path
 * without spawning the CLI.
 */
export function handle_patch_command(
    patchlab_id: string,
    options: { session?: number; repository?: string; output?: string },
): void {
    assert_valid_patchlab_id(patchlab_id);
    const patch = options.session === undefined
        ? generate_patch(patchlab_id, { repository_root: options.repository })
        : generate_session_patch(patchlab_id, options.session);

    if (patch === '') {
        logger().info('No changes to export.');
        return;
    }
    if (options.output) {
        const written = write_patch(patch, options.output);
        logger().info(`Patch written to: ${written}`);
        return;
    }

    // ConsoleLogger.result appends `\n` iff the input doesn't already
    // end with one. `git diff` (the source of `patch` via
    // generate_patch) reliably terminates its output with `\n`, so the
    // append is a no-op for the common case and the bytes piped to
    // `git apply` match the pre-Logger `process.stdout.write(patch)`
    // contract exactly. If a future patch source emits a stream that
    // does NOT end in `\n`, the Logger will append one — same as
    // `console.log` would have.
    logger().result(patch);
}

program
    .command('apply')
    .description('Apply a patchlab branch onto the current branch')
    .argument('<patchlab>', 'Patchlab identifier')
    .option('--session <number>', 'Apply only the given session', parse_session_number)
    .option('--merge [strategy]', 'Merge instead of cherry-picking; strategy is "commit" (default) or "squash"')
    .option('--include-baseline', 'Cherry-pick the baseline commit before sessions (recovery)')
    .option('--repository <path>', 'For multi-repository patchlabs, the host repository whose patchlab branch to apply. Optional (and defaults to the only repository) for single-repository patchlabs; REQUIRED for multi-repository patchlabs.')
    .option('--force', 'Required in non-interactive mode for destructive applies')
    .action(handle_apply_command);

/**
 * Commander callback that accumulates repeated `--source <path>` flag values
 * into an array. Commander invokes the callback once per occurrence; the
 * second parameter is the running accumulator.
 */
function collect_repeatable_source(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/**
 * Implementation of the `patchlab apply` subcommand, wired into Commander
 * by `program.command('apply').action(handle_apply_command)` above. Exported
 * (rather than declared inline) so unit tests can invoke the handler
 * directly, spy on its dependencies, and assert that it does NOT route
 * through `register_per_source_manifests` or `verify_per_source_trust` —
 * see `test/unit/non-gated-operations.test.ts` task 6.21.
 */
export async function handle_apply_command(
    patchlab_id: string,
    options: {
        session?: number;
        merge?: string | boolean;
        include_baseline?: boolean;
        repository?: string;
        force?: boolean;
    }
): Promise<void> {
    assert_valid_patchlab_id(patchlab_id);
    const mode = resolve_apply_mode(options.merge);
    if (!options.force && !process.stdin.isTTY) {
        logger().error('patchlab apply: --force is required in non-interactive mode.');
        process.exitCode = 1;
        return;
    }

    const manifest = read_manifest(build_archive_path(patchlab_id));
    const repository_root = resolve_apply_repository(manifest, options.repository);
    const result = apply_patchlab_branch(repository_root, patchlab_id, {
        session_number: options.session,
        mode,
        include_baseline: options.include_baseline,
    });
    print_branch_apply_result(result, patchlab_id);
    if (result.conflict) {
        process.exitCode = 1;
    }
}

function print_branch_apply_result(result: Apply_Result, patchlab_id: string): void {
    if (result.nothing_to_apply) {
        logger().info(`No commits to apply from ${patchlab_branch_name(patchlab_id)}.`);
        return;
    }

    if (result.skipped.length > 0) {
        const sessions = result.skipped
            .map((s) => s.session_number === null ? 'baseline' : `session ${s.session_number}`)
            .join(', ');
        logger().info(`Skipped (already applied): ${sessions}`);
    }

    for (const item of result.applied) {
        const label = item.session_number === null ? 'baseline' : `session ${item.session_number}`;
        logger().info(`Applied ${label} (${item.commit_sha.slice(0, 8)})`);
    }

    if (result.conflict) {
        const conflict = result.conflict;
        const label = conflict.session_number === null
            ? 'merge'
            : `session ${conflict.session_number} (${conflict.commit_sha.slice(0, 8)})`;
        logger().error(`\nConflict during ${label}.`);
        if (conflict.submodule_paths.length > 0) {
            logger().error(`Submodule paths involved: ${conflict.submodule_paths.join(', ')}`);
            logger().error('Submodule changes must be applied manually inside each submodule.');
        }
        if (conflict.message) {
            logger().error(conflict.message);
        }
        logger().error('Resolve conflicts with standard git tooling and re-run.');
        return;
    }

    if (result.applied.length === 0 && result.skipped.length > 0) {
        logger().info('All sessions were already applied; nothing new to do.');
    }
}

program
    .command('resume')
    .description('Resume a patchlab in a fresh sandbox from the branch tip + host overlay')
    .argument('<patchlab>', 'Patchlab identifier')
    .option('--no-install', 'Skip automatic dependency install')
    .option('--no-interactive', 'Skip interactive AI tool launch (for scripts/tests)')
    .option('--context <paths...>', 'Additional context files to merge with the previous session\'s context')
    .option('--copy <source[:destination]>', 'Copy a host file or directory into the sandbox workspace (repeatable; merged with previous session\'s copies; secret-pattern files are not blocked but a warning is emitted)',
        (value, previous: Copy_Specification[]) => previous.concat([parse_copy_specification(value)]), [] as Copy_Specification[])
    .option('--memory <value>', 'Memory limit override for this resume; 0 = unlimited (otherwise inherits from prior session)', parse_memory_value)
    .option('--cpus <value>', 'CPU limit override for this resume; 0 = unlimited (otherwise inherits from prior session)', parse_cpus_value)
    .option('--pids-limit <value>', 'Process count override for this resume; 0 = unlimited (otherwise inherits)', parse_pids_value)
    .option('--blkio-weight <value>', 'Block I/O weight override for this resume; range [10, 1000] (otherwise inherits)', parse_blkio_weight_value)
    .action(handle_resume_command);

/**
 * Implementation of the `patchlab resume` subcommand. Exported so unit tests
 * can drive the confirm callbacks (active-sandbox replace, oversized-archive
 * transfer) and the post-resume interactive-launch + extract handoff without
 * spawning the CLI.
 */
export async function handle_resume_command(
    patchlab_id: string,
    options: {
        install?: boolean;
        interactive?: boolean;
        context?: string[];
        copy?: Copy_Specification[];
        memory?: CLI_Limit_Overrides['memory_limit'];
        cpus?: CLI_Limit_Overrides['cpu_limit'];
        pids_limit?: CLI_Limit_Overrides['pids_limit'];
        blkio_weight?: CLI_Limit_Overrides['blkio_weight'];
    },
): Promise<void> {
    assert_valid_patchlab_id(patchlab_id);
    // Single prompter for this command action; threaded into trust verify,
    // the two confirm_* callbacks below, and the post-resume extract step.
    const prompter = resolve_runtime_prompter();
    const cli_resource_overrides: CLI_Limit_Overrides = {
        memory_limit: options.memory,
        cpu_limit: options.cpus,
        pids_limit: options.pids_limit,
        blkio_weight: options.blkio_weight,
    };

    // Look up `repository_root` from the existing sandbox manifest so the
    // per-source configuration file at
    // `<repository_root>/.patchlab/configuration.yaml` is read across
    // EVERY repository the prior create used (per multi-source-trust's
    // composition rule). `resume_sandbox` re-reads the manifest internally
    // — accepting a tiny double-read here keeps cli.ts as the single
    // configuration-loading site (per task 3.1).
    const resume_manifest = read_manifest(build_archive_path(patchlab_id));
    const loaded_configuration = load_configuration_or_exit(
        manifest_repositories(resume_manifest),
    );

    const manifest = await resume_sandbox(patchlab_id, {
        no_install: options.install === false,
        context_paths: options.context,
        copy_paths: options.copy,
        trust_options: resolve_trust_options(prompter),
        cli_resource_overrides,
        loaded_configuration,
        prompter,
    });
    logger().info(`Patchlab resumed: ${manifest.id}`);
    logger().info(`Container: ${manifest.container_name}`);
    logger().info(`Branch: ${patchlab_branch_name(manifest.id)}`);

    if (options.interactive === false) {
        return;
    }

    const tool_name = resolve_manifest_tool(manifest);
    const provider = get_provider(tool_name);
    const working_directory = compute_container_workspace_path(provider);
    try {
        exec_interactive(manifest.container_name, provider.get_launch_command(), working_directory);
    } catch (error) {
        const code = error instanceof Error && 'status' in error
            ? (error as { status?: number }).status
            : undefined;
        const suffix = code ? ' with code ' + code : '';
        logger().info('Shell exited' + suffix + '.');
    }

    await extract_session_to_branch(manifest, working_directory, prompter);
}

program
    .command('exec')
    .description('Execute a command inside a sandbox container')
    .argument('<sandbox>', 'Sandbox identifier')
    .argument('<command...>', 'Command to run')
    .action(handle_exec_command);

/** Implementation of the `patchlab exec` subcommand. Exported for unit testing. */
export function handle_exec_command(sandbox_id: string, command: string[]): void {
    assert_valid_patchlab_id(sandbox_id);
    const details = inspect_sandbox(sandbox_id);
    try {
        exec_interactive(details.container_name, command, details.container_working_dir);
    } catch (error) {
        // `exec_interactive` (execFileSync, stdio inherit) throws on any nonzero
        // child exit. Relay the child's exit code so `patchlab exec` stays
        // scriptable instead of surfacing an internal stack trace and flattening
        // every failure to exit 1. Mirrors the create/resume catch but propagates
        // the code rather than logging. The child's own output already reached the
        // inherited stderr, so no diagnostic is lost.
        const code = error instanceof Error && 'status' in error
            ? (error as { status?: number }).status
            : undefined;
        process.exitCode = code ?? 1;
    }
}

program
    .command('build-image')
    .description('Build a patchlab-compatible container image with tools pre-installed')
    .option('--base <image>', 'Base image (default: node:22-slim)')
    .option('--tools <tools...>', 'Tools to install (required). Run `patchlab list-tools` to see available providers')
    .option('--tag <tag>', 'Image tag (default: patchlab/<base>:latest)')
    .option('--exclude-suggested', 'Skip extensions listed in composer.json suggest (default: include them)')
    .action(handle_build_image_command);

/**
 * Detects the base image and requirements for the project.
 * @param project_directory
 * @param base_image
 * @param exclude_suggested
 * @returns
 */
function detect_base_image(
    project_directory: string,
    base_image: string,
    exclude_suggested: boolean,
): {
     base_image: string; detected_requirements: Detected_Requirements }
{
    // When CWD has no language markers (e.g. a workspace root with a
    // .patchlab.json listing the actual source projects), fall back to
    // the first listed source directory for both image and requirements
    // detection — that's where composer.json / package.json lives.
    const cwd_detected = detect_project(project_directory);
    let detection_directory = project_directory;
    if (cwd_detected.length === 0) {
        const manifest_sources = load_sources_from_manifest(project_directory);
        if (manifest_sources && manifest_sources.entries.length > 0) {
            const first_entry = manifest_sources.entries[0];
            const first_path = typeof first_entry === 'string' ? first_entry : first_entry.path;
            detection_directory = path.resolve(manifest_sources.base_directory, first_path);
        }
    }

    if (!base_image) {
        const detected = detection_directory === project_directory
            ? cwd_detected
            : detect_project(detection_directory);
        if (detected.length > 0) {
            base_image = detected[0].image;
            logger().info(`Detected: ${detected[0].marker} → ${detected[0].language} → ${base_image}`);
            if (detected.length > 1) {
                const others = detected.slice(1).map((d) => d.marker + ' (' + d.language + ')').join(', ');
                logger().info('Also found: ' + others);
                logger().info('Using first match. Override with --base <image>');
            }
        }
    }

    const detected_requirements = detect_requirements(detection_directory, {
        exclude_suggested_extensions: exclude_suggested,
    });
    return { base_image, detected_requirements };
}

/**
 * Implementation of the `patchlab build-image` subcommand. Exported so unit
 * tests can drive the project-detection and capability-detection paths
 * without spawning the CLI.
 */
export async function handle_build_image_command(
    options: { base?: string; tools?: string[]; tag?: string; exclude_suggested?: boolean },
): Promise<void> {
    const project_directory = process.cwd();

    const { base_image, detected_requirements } = detect_base_image(
        project_directory,
        options.base ?? '',
        options.exclude_suggested ?? false,
    );

    const overrides = load_overrides(project_directory);
    const merged = merge_requirements(detected_requirements, overrides);
    const capabilities = merged.system_packages.map((r) => r.capability);

    if (capabilities.length > 0) {
        for (const requirement of merged.system_packages) {
            logger().info(`Detected requirement: system package ${requirement.capability} (from: ${requirement.source})`);
        }
    }

    if (options.tools === undefined || options.tools.length === 0) {
        logger().error(
            'patchlab build-image: --tools is required. '
            + 'Run `patchlab list-tools` to see available providers.',
        );
        process.exit(1);
    }

    logger().info('Building patchlab image...');
    const tag = await build_image({
        base_image,
        tools: options.tools,
        tag: options.tag,
        project_directory,
        capabilities,
    });
    logger().info(`\nImage built: ${tag}`);
    logger().info('Use with: patchlab create <source> --image ' + tag);
}

/**
 * Construct the per-orphan-branch confirmation callback for `garbage_collect_sandboxes`.
 *
 * Returns `undefined` when `force` is set (force-delete every orphan) OR when
 * the prompter is `null` (non-interactive; `garbage_collect_sandboxes` will
 * treat unapplied orphans as `'skipped'` without `force`). Otherwise returns
 * a prompt that asks the user per orphan branch with unapplied session
 * commits. The non-interactive gate is the same shape as the pre-existing
 * `!process.stdin.isTTY` check; the prompter `null` value carries the
 * same meaning under the Prompter contract.
 */
function build_orphan_branch_confirm(
    force: boolean | undefined,
    prompter: Prompter | null,
): Garbage_Collection_Options['confirm_orphan_branch_deletion'] {
    return (force || prompter === null) ? undefined
        : async (repository_root, branch, unapplied_count) => prompter.confirm(
        `\nOrphan branch ${branch} in ${repository_root} has ${unapplied_count} unapplied session commit(s). `
        + `Delete anyway? [y/N] `,
        { default_yes: false },
    );
}

/** Print the per-repository per-orphan-branch outcomes from a gc run. */
function report_orphan_outcomes(
    orphan_outcomes: Record<string, Record<string, Orphan_Branch_Outcome>>,
): void {
    for (const [repository_root, per_branch] of Object.entries(orphan_outcomes)) {
        const entries = Object.entries(per_branch);
        if (entries.length === 0) {
            continue;
        }

        logger().info(`Orphan branches in ${repository_root}:`);
        for (const [branch, outcome] of entries) {
            logger().info(`  ${branch}: ${outcome}`);
        }
    }
}

function parse_older_than_days(value: string): number {
    // Reject anything that is not a bare non-negative integer. A plain
    // `Number.parseInt` would accept `5xyz` (→ 5), `0x10` (radix surprise), and
    // `-3`, silently widening or inverting the gc window.
    if (!/^\d+$/.test(value.trim())) {
        throw new InvalidArgumentError('--older-than expects a non-negative integer number of days.');
    }

    return Number.parseInt(value, 10);
}

program
    .command('gc')
    .alias('garbage-collect')
    .description('Remove stale sandboxes')
    .option('--older-than <days>', 'Remove sandboxes older than N days (default: 7)', parse_older_than_days)
    .option('--no-missing', 'Skip sandboxes whose containers no longer exist (included by default)')
    .option('--dry-run', 'Show what would be removed without removing')
    .option('--force', 'Skip confirmation prompt')
    .action(handle_gc_command);

/**
 * Implementation of the `patchlab gc` subcommand. Exported so unit tests can
 * drive the preview/confirm/execute sequence and the orphan-branch deletion
 * gate without spawning the CLI.
 */
export async function handle_gc_command(
    options: { older_than?: number; missing?: boolean; dry_run?: boolean; force?: boolean },
): Promise<void> {
    const prompter = resolve_runtime_prompter();
    // Always preview first
    const preview = await garbage_collect_sandboxes({
        older_than_days: options.older_than,
        include_missing: options.missing,
        dry_run: true,
    });

    if (preview.destroyed.length === 0) {
        logger().info('Nothing to clean up.');
        return;
    }

    for (const s of preview.destroyed) {
        const reason = s.container_status === 'missing' ? 'missing' : 'stale';
        logger().info(`  ${s.id}  (${reason}, created ${s.created_at})`);
    }

    if (options.dry_run) {
        logger().info(`\n${preview.destroyed.length} sandbox(es) would be removed.`);

        return;
    }

    if (!options.force) {
        const approved = await (prompter?.confirm(
            `\nRemove ${preview.destroyed.length} sandbox(es)? [Y/n] `,
            { default_yes: true },
        ) ?? Promise.resolve(false));

        if (!approved) {
            return;
        }
    }

    const result = await garbage_collect_sandboxes({
        older_than_days: options.older_than,
        include_missing: options.missing,
        force: options.force,
        confirm_orphan_branch_deletion: build_orphan_branch_confirm(options.force, prompter),
    });

    if (result.destroyed.length !== preview.destroyed.length) {
        logger().warn(
            `Removed ${result.destroyed.length} sandbox(es), but the preview listed `
            + `${preview.destroyed.length}; the set changed between confirmation and removal.`
        );
    }

    logger().info(`${result.destroyed.length} sandbox(es) removed.`);
    report_orphan_outcomes(result.orphan_outcomes);
}

program
    .command('list-tools')
    .description('List registered tool providers (built-in + user-global). Pass a source path to also include per-source manifests under <repository_root>/.patchlab/tools/.')
    .argument('[source]', 'Source directory to also include per-source manifests from (the repository root containing it is scanned)')
    .action(handle_list_tools_command);

/**
 * Implementation of the `patchlab list-tools` subcommand. Exported so unit
 * tests can drive the per-source manifest registration path without spawning
 * the CLI.
 */
export function handle_list_tools_command(source: string | undefined): void {
    if (source === undefined) {
        run_list_tools();
        return;
    }

    // The user passes any source directory; we resolve to the
    // repository root and register per-repository under the
    // single-repository invariant.
    const source_path = path.resolve(source);
    const repository_root = get_repository_root(source_path);
    let cached_buffers: Map<string, Buffer> | null = null;
    run_list_tools({
        source_path: repository_root,
        register_per_source: (resolved_repository_root) => {
            const result = register_per_source_manifests([resolved_repository_root]);
            cached_buffers = result.manifest_buffers;
            return result.errors;
        },
        is_per_source_unconfirmed: (resolved_repository_root) => {
            const buffers = cached_buffers ?? new Map<string, Buffer>();
            return is_per_source_unconfirmed(resolved_repository_root, buffers);
        },
    });
}

program
    .command('list-images')
    .alias('images')
    .description('List patchlab-compatible container images')
    .action(handle_images_command);

/** Implementation of the `patchlab list-images` subcommand. Exported for unit testing. */
export function handle_images_command(): void {
    const images = list_images();
    if (images.length === 0) {
        logger().info('No patchlab-compatible images found.');
        logger().info('Run: patchlab build-image');
        return;
    }
    for (const image of images) {
        const tool_display = Object.entries(image.tool_states)
            .map(([name, state]) => `${name} (${state})`)
            .join(', ');
        const tools_info = tool_display || image.tools.join(', ') || 'none';
        logger().result(`${image.repository}:${image.tag}  (${image.id})  tools: ${tools_info}`);
    }
}

// Gate Commander's argv parse on direct invocation so unit tests can import
// this module (and exported handlers like `handle_apply_command`) without
// firing `program.parse()` against the test runner's argv. `require.main`
// is the Module object Node was launched with; identity-compare against
// the current `module` so this branch fires only under direct
// `node dist/cli.js` (and bin shims that resolve to the same Module via
// Node's symlink-aware loader), never under vitest's import.
if (require.main === module) {
    // parseAsync (not parse): the action handlers are async, and Commander
    // does NOT await them under the synchronous parse(). Without this, a
    // handler that rejects (e.g. a failed create after rollback) escapes as an
    // unhandled rejection — its diagnostics race the process teardown and the
    // exit code is left to Node's default. Awaiting here lets us route the
    // error through logger().error and set a deterministic non-zero exit code.
    program.parseAsync().catch((error) => {
        logger().error(error instanceof Error ? error : new Error(String(error)));
        process.exit(1);
    });
}
