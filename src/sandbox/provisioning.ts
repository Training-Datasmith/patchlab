import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
    create_manifest,
    manifest_repositories,
    read_manifest,
    resolve_manifest_tool,
    write_manifest,
    type Sandbox_Manifest,
    type Source_Specification,
} from '../manifest.js';
import {
    build_archive_path,
    build_session_path,
    latest_session_with_metadata,
} from '../archive.js';
import {
    branch_exists,
    export_per_source_branch_tip_to_container,
    is_git_repository,
    list_branch_files,
    patchlab_branch_name,
} from '../branch/index.js';
import {
    check_required_for_resume,
    write_initial_session_metadata,
} from './session_archive.js';
import {
    inject_context_bundle,
    inject_resume_context,
} from './context_injection.js';
import {
    configure_composer_path_repositories,
    copy_multi_source_files,
    copy_additional_paths,
    detect_secret_copies,
    initialize_sandbox_git_baseline,
    install_dependencies,
    install_npm_packages,
    overlay_into_container,
    overlay_multi_source_host_files,
    prepare_workspace,
} from './workspace_staging.js';
import {
    copy_workspace_copies_to_archive,
    restore_workspace_copies,
    merge_resume_workspace_copies,
    type Copy_Specification,
} from './workspace_copies.js';
import { detect_requirements, type Npm_Package_Requirement } from '../detect/index.js';
import { load_overrides } from '../overrides.js';
import { merge_requirements } from '../overrides_merge.js';
import type { Prompter } from '../prompts.js';
import { resolve_socket_mount } from '../prompts.js';
import { resolve_services, merge_service_selections } from '../services.js';
import { build_volume_mounts, build_environment_variables } from '../container_options.js';
import { format_bytes } from '../format.js';
import { check_stale_image } from '../stale.js';
import { logger } from '../logger.js';
import {
    DEFAULT_IMAGE,
    container_name_for,
    create_container,
    start_container,
    stop_and_remove_container_best_effort,
    container_exists,
    was_authentication_attempted_at_build,
} from '../podman.js';
import {
    resolve_effective_image,
    set_up_image_tier,
    type Resolved_Image,
} from './image_tier.js';
import { compute_container_workspace_path, get_provider, register_per_source_manifests } from '../tools/index.js';
import {
    verify_per_source_trust_multi_repository,
    type Confirm_Per_Source_Options,
} from '../tools/configured_provider/trust_verification.js';
import type { Authentication_Result } from '../tools/types.js';

import {
    collect_unique_repositories,
    execute_phase_1_preflight,
    execute_phase_2_mutations,
    rollback_phase_2_created_branches,
    validate_source_paths,
} from './branch_handshake.js';
import {
    resolve_resource_limits,
    resolved_limits_to_create_options,
    type CLI_Limit_Overrides,
} from '../resource_limits.js';
import {
    EMPTY_LOADED_CONFIGURATION,
    read_persisted_resource_limits,
} from './persisted_resource_limits.js';
import type { Loaded_Configuration } from '../configuration.js';
import { warn_once_if_unsupported } from '../cgroups.js';

export interface Create_Sandbox_Options {
    include?: string[];
    exclude?: string[];
    image?: string;
    tool?: string;
    no_install?: boolean;
    force_rebuild?: boolean;
    allow_socket_mount?: boolean;
    deny_socket_mount?: boolean;
    volume_mounts?: string[];
    environment_variables?: Record<string, string>;
    npm_packages?: Npm_Package_Requirement[];
    /**
     * When the host working tree is dirty, controls whether to proceed.
     * - `true`: proceed; the dirty state is captured as a labeled baseline commit on the patchlab branch.
     * - `false`: abort with an error.
     * - `undefined`: abort with an instructive error (caller must decide via prompt).
     */
    allow_dirty_tree?: boolean;
    /**
     * When the host repository contains submodules, controls whether to proceed.
     * Submodules are not supported and may cause apply failures.
     * - `true`: proceed (treat submodule contents as regular files).
     * - `false` or `undefined`: abort with an error.
     */
    allow_submodules?: boolean;
    /**
     * Context paths to inject into the sandbox at `$HOME/context/` and into
     * `sessions/1/context/` in the archive. Relative paths preserve their structure;
     * absolute paths use only the filename; first-wins on archive-path conflicts.
     */
    context_paths?: string[];
    /**
     * Host files or directories to copy into the sandbox workspace before the git
     * baseline is committed, preserving their content across resumes. Gitignored
     * copies (e.g. `composer.lock`) are present in the workspace filesystem and
     * readable by tools but not committed to the baseline. Source paths and
     * destinations are validated by `parse_copy_specification` before this point.
     */
    copy_paths?: Copy_Specification[];
    /**
     * When true, the default secret-pattern excludes (`.env`, `*.pem`, SSH keys, etc.)
     * are NOT applied. Default: false. Use this only when you know the source tree's
     * secret-pattern files are safe to ship into the sandbox.
     */
    include_secret_files?: boolean;
    /**
     * Per-invocation resource-limit overrides parsed from the CLI flags
     * `--memory`, `--cpus`, `--pids-limit`, `--blkio-weight`. Each field is
     * `undefined` when the user did not pass the flag; the resolver falls
     * through to lower-precedence sources for those fields.
     */
    cli_resource_overrides?: CLI_Limit_Overrides;
    /**
     * User-global and per-source configuration values from
     * `~/.patchlab/configuration.yaml` and `<source>/.patchlab/configuration.yaml`.
     * The CLI calls `load_configuration` once before invoking
     * `create_sandbox` and passes the result through here so the resolver can
     * apply the user-global and per-source-clamped layers below the persisted
     * manifest and CLI layers. Defaults to `{ user_global: null, per_source: null }`
     * (no configuration files consulted) when omitted.
     */
    loaded_configuration?: Loaded_Configuration;
    /**
     * Prompter for interactive confirmations. Pass a `Prompter` instance for
     * TTY mode (dirty-tree, submodule, socket-mount, service, and trust
     * prompts are forwarded to it) or `null` for non-interactive mode (any
     * prompt condition that would have prompted throws instead). When omitted,
     * defaults to `null`.
     */
    prompter?: Prompter | null;
    /**
     * Carry `--allow-untrusted-manifests` into the library for non-interactive
     * callers that need to bypass the per-source trust prompt without prompting.
     * Mutually exclusive with `strict_trust`. Has no effect in TTY mode.
     */
    allow_untrusted_manifests?: boolean;
    /**
     * Carry `--strict-trust` into the library: semantically a no-op (default
     * non-TTY behavior is already abort), but exists for scripts that want to
     * declare the trust posture explicitly. Mutually exclusive with
     * `allow_untrusted_manifests`. Has no effect in TTY mode.
     */
    strict_trust?: boolean;
    /**
     * When true, scan each source's composer.json for a `name` field, cross-
     * reference against other sources' `require`/`require-dev` entries, and
     * configure matching packages as composer path repositories in the
     * container's global composer configuration before `composer install` runs.
     */
    composer_path_repositories?: boolean;
}





// Image-tier resolution and tag computation extracted to ./sandbox/image_tier.ts



/**
 * Pre-create authentication injection for `'environment_variables'` providers:
 * vars must pass to `podman create`, so injection runs BEFORE the container
 * is created. Returns the result alongside the variable map; `'file_copy'`
 * and `'none'` providers short-circuit with `type: 'none'` and an empty map.
 */
function inject_pre_create_authentication(
    provider: ReturnType<typeof get_provider>,
    sandbox_id: string,
): { authentication_result: Authentication_Result; extra_environment_variables: Record<string, string> } {
    const extra_environment_variables: Record<string, string> = {};
    if (provider.get_authentication_method() !== 'environment_variables') {
        return { authentication_result: { type: 'none' }, extra_environment_variables };
    }
    const authentication_result = provider.inject_authentication({ sandbox_id });
    if (authentication_result.type === 'environment_variables') {
        for (const entry of authentication_result.entries) {
            extra_environment_variables[entry.name] = entry.value;
        }
    }
    return { authentication_result, extra_environment_variables };
}

/**
 * Post-create authentication injection for `'file_copy'` providers: files
 * `podman cp` into the running container, so injection runs AFTER create.
 * The inject-skip uses `was_authentication_attempted_at_build` so a cached
 * image carrying either `'authenticated'` (credentials baked into image
 * bytes) or `'ready'` short-circuits the re-copy. The outer
 * `get_authentication_method() === 'file_copy'` gate prevents a legacy
 * `'authenticated'` label on an env-var-method image from reaching this
 * site (env-var providers route through the pre-create phase, which always
 * re-injects on every container creation).
 */
function inject_post_create_authentication(
    provider: ReturnType<typeof get_provider>,
    sandbox_id: string,
    container_name: string,
    image_resolution: Resolved_Image,
    prior_authentication_result: Authentication_Result,
): Authentication_Result {
    if (provider.get_authentication_method() !== 'file_copy') {
        return prior_authentication_result;
    }
    if (was_authentication_attempted_at_build(image_resolution.tool_state)) {
        return { type: 'file_copy' };
    }
    return provider.inject_authentication({ sandbox_id, container_name });
}


/**
 * Roll back a failed create after Phase 2 succeeded: stop and remove the
 * container, force-delete every Phase-2-created branch (safe because none
 * carry session commits yet), then remove the archive directory. Leaves
 * the host as if the create never started.
 */
function rollback_failed_create(
    container_name: string,
    sandbox_directory: string,
    patchlab_id: string,
    created_branch_repositories: string[],
): void {
    stop_and_remove_container_best_effort(container_name);

    if (created_branch_repositories.length > 0) {
        rollback_phase_2_created_branches(created_branch_repositories, patchlab_id);
    }

    fs.rmSync(sandbox_directory, { recursive: true, force: true });
}

interface Provision_New_Sandbox_Input {
    patchlab_id: string;
    container_name: string;
    sources: Source_Specification[];
    options: Create_Sandbox_Options | undefined;
    provider: ReturnType<typeof get_provider>;
    image: string;
    tool_name: string;
    working_directory: string;
    sandbox_directory: string;
    baseline_commit_shas: Record<string, string | null>;
    branch_creation_point_shas: Record<string, string | null>;
    resolved_volume_mounts: string[];
    resolved_environment_variables: Record<string, string>;
    resolved_npm_packages: Npm_Package_Requirement[];
}

/**
 * Provision the container, populate its workspace, install dependencies, and
 * write the manifest plus the first session's metadata. Throws on any failure;
 * the caller's catch path rolls back Phase 2 branches and removes the archive
 * directory.
 *
 * Authentication injection runs in two phases gated by the provider's
 * declared method:
 *   - `'environment_variables'` providers inject pre-create so vars can pass
 *     to `podman create`.
 *   - `'file_copy'` providers inject post-create so files can `podman cp`
 *     into the running container.
 *   - `'none'` providers skip both phases.
 */
async function provision_new_sandbox(input: Provision_New_Sandbox_Input): Promise<Sandbox_Manifest> {
    const {
        patchlab_id, container_name, sources, options, provider, image, tool_name,
        working_directory, sandbox_directory, baseline_commit_shas, branch_creation_point_shas,
        resolved_volume_mounts, resolved_environment_variables, resolved_npm_packages,
    } = input;

    // Resolve resource limits (defaults → user-global → per-source-clamped
    // → manifest → CLI). First create has no manifest layer; the resolver
    // falls through to defaults for anything no higher layer overrides.
    const resolved_limits = resolve_resource_limits(
        options?.loaded_configuration ?? EMPTY_LOADED_CONFIGURATION,
        null,
        options?.cli_resource_overrides ?? {},
    );
    const limit_create_options = resolved_limits_to_create_options(resolved_limits);

    const image_resolution = resolve_effective_image(image, tool_name, provider, options);
    let effective_image = image_resolution.effective_image;

    const secret_copy_paths = detect_secret_copies(options?.copy_paths ?? []);
    if (secret_copy_paths.length > 0) {
        // One prompt listing all offending paths. The outcome is all-or-nothing
        // (proceed with every copy or abort), so per-path prompts would mislead
        // the user into thinking they can accept some and reject others.
        // If we add the ability to accept some and reject others, we'll need to
        // rework this prompt to handle that.
        const path_list = secret_copy_paths.map((p) => `  • ${p}`).join('\n');
        const confirmed = await (options?.prompter?.confirm(
            'The following --copy sources match a secret-file pattern (.env, *.pem, SSH keys, etc.):\n'
            + path_list + '\n'
            + 'The AI tool will have read access to this content, and the sandbox image will be tagged as auth. '
            + 'Proceed? [y/N]',
        ) ?? Promise.resolve(false));
        if (!confirmed) {
            throw new Error('Secret-file --copy not confirmed; create aborted.');
        }
    }

    const pre_create = inject_pre_create_authentication(provider, patchlab_id);
    const { extra_environment_variables } = pre_create;
    let authentication_result = pre_create.authentication_result;

    create_container(container_name, effective_image, {
        volume_mounts: resolved_volume_mounts,
        environment_variables: resolved_environment_variables,
        extra_environment_variables: Object.keys(extra_environment_variables).length > 0 ? extra_environment_variables : undefined,
        memory_limit: limit_create_options.memory_limit,
        cpu_limit: limit_create_options.cpu_limit,
        pids_limit: limit_create_options.pids_limit,
        blkio_weight: limit_create_options.blkio_weight,
    });
    start_container(container_name);

    authentication_result = inject_post_create_authentication(
        provider, patchlab_id, container_name, image_resolution, authentication_result,
    );

    // Secret files accepted by the user: promote a 'none' auth result to
    // 'file_copy' so set_up_image_tier uses the -auth tag and 'authenticated'
    // label. This marks the image as containing sensitive content. When the
    // provider already performed real authentication (file_copy or
    // environment_variables), the auth tag is already guaranteed.
    if (secret_copy_paths.length > 0 && authentication_result.type === 'none') {
        authentication_result = { type: 'file_copy' };
    }

    effective_image = set_up_image_tier(
        container_name, effective_image, image_resolution, tool_name, authentication_result, provider, options,
    );

    // Workspace population. A source whose `mount_name` is empty
    // (single-source-at-repository-root with no override) lands its contents
    // at `${working_directory}/` directly; non-empty mounts land at
    // `${working_directory}/<mount_name>/`. The container's git repository
    // initializes AFTER the copy loop so it sees every mount as a top-level
    // subdirectory.
    copy_multi_source_files(container_name, sources, options, working_directory);
    copy_additional_paths(container_name, options?.copy_paths ?? [], working_directory);
    initialize_sandbox_git_baseline(container_name, working_directory);

    if (options?.composer_path_repositories) {
        configure_composer_path_repositories(container_name, sources, working_directory);
    }

    if (!options?.no_install) {
        install_dependencies(container_name, working_directory);
    }

    if (resolved_npm_packages.length > 0) {
        install_npm_packages(container_name, resolved_npm_packages, working_directory);
    }

    const manifest = create_manifest(patchlab_id, sources, container_name, image, {
        include: options?.include,
        exclude: options?.exclude,
        baseline_commit_shas,
        branch_creation_point_shas,
    });
    manifest.effective_image = effective_image;
    manifest.tool = tool_name;
    manifest.volume_mounts = resolved_volume_mounts;
    manifest.environment_variables = resolved_environment_variables;
    manifest.npm_packages = resolved_npm_packages;
    write_manifest(sandbox_directory, manifest);

    const session_number = write_initial_session_metadata(
        patchlab_id, tool_name, container_name, manifest, resolved_limits,
    );

    if (options?.context_paths && options.context_paths.length > 0) {
        inject_context_bundle(
            patchlab_id,
            session_number,
            container_name,
            provider.image_specification.image_home,
            options.context_paths,
        );
    }

    if (options?.copy_paths && options.copy_paths.length > 0) {
        copy_workspace_copies_to_archive(options.copy_paths, patchlab_id, session_number);
    }

    return manifest;
}

/**
 * Union detected and caller-provided npm packages, with caller winning on
 * package-name conflict. Both sets come from `Npm_Package_Requirement[]`;
 * dedup keyed on `package` name mirrors the first-wins rule inside
 * `detect_requirements` but inverts it so explicit caller intent wins.
 */
function merge_npm_packages(
    detected: Npm_Package_Requirement[],
    caller: Npm_Package_Requirement[],
): Npm_Package_Requirement[] {
    const result = new Map<string, Npm_Package_Requirement>(detected.map(p => [p.package, p]));
    for (const requirement of caller) {
        result.set(requirement.package, requirement);
    }
    return Array.from(result.values());
}

/**
 * Build the set of workspace-relative paths tracked on the patchlab branch
 * across all sources. Used by `provision_resumed_sandbox` to exclude branch-
 * tracked files from the host-overlay step so host files never overwrite
 * branch-committed content.
 */
function build_branch_file_set(manifest: Sandbox_Manifest, branch_name: string): Set<string> {
    const branch_files = new Set<string>();
    for (const source of manifest.sources) {
        for (const path of list_branch_files(source.repository_root, branch_name, source.source_prefix)) {
            branch_files.add(source.mount_name === '' ? path : `${source.mount_name}/${path}`);
        }
    }

    return branch_files;
}

/**
 * Build the `confirm_oversized` callback for `export_per_source_branch_tip_to_container`
 * when a prompter is present, or return `undefined` for non-interactive context
 * (archive.ts will throw its standard non-interactive error).
 */
function build_oversized_confirm(
    prompter: Prompter | null,
): ((size_bytes: number) => Promise<boolean>) | undefined {
    if (prompter === null) {
        return undefined;
    }

    return async (size_bytes: number) => {
        logger().warn(
            `Branch archive is ${format_bytes(size_bytes)} — larger than the default cap. `
            + `Streaming it into the new sandbox may take a while.`,
        );
        return prompter.confirm('Proceed with resume? [y/N] ', { default_yes: false });
    };
}

/** Create an isolated sandbox by launching a Podman container with source files and git baseline. */
export async function create_sandbox(
    sources: Source_Specification[],
    options?: Create_Sandbox_Options
): Promise<Sandbox_Manifest> {
    validate_source_paths(sources);
    const repositories = collect_unique_repositories(sources);

    // Trust verification: mirrors the CLI's up-front register + verify before
    // any branch or container work. Calling both here makes `create_sandbox()`
    // self-sufficient for non-CLI callers; for the CLI this is a redundant
    // second call (the CLI already ran it before image building) but the
    // verify is idempotent — the trust marker is already written, so the
    // prompt path is not reached again.
    const registration_result = register_per_source_manifests(repositories);
    const trust_options: Confirm_Per_Source_Options = {
        strict_trust: options?.strict_trust,
        allow_untrusted_manifests: options?.allow_untrusted_manifests,
        prompter: options?.prompter ?? null,
    };
    await verify_per_source_trust_multi_repository(
        repositories,
        registration_result.manifest_buffers,
        registration_result.registered_manifests,
        registration_result.registered_manifest_repositories,
        registration_result.errors,
        trust_options,
    );

    // Phase 1 (pre-flight, no mutations): for every repository, run is-git-
    // repository, submodule detection, dirty-tree detection, and branch-existence
    // check. Phase 1 mutates NOTHING on any host git repository.
    const id = crypto.randomUUID();
    const dirty_repositories = await execute_phase_1_preflight(repositories, id, options);

    if (options?.tool === undefined || options.tool === '') {
        throw new Error('create_sandbox requires options.tool');
    }

    const tool_name = options.tool;
    const provider = get_provider(tool_name);
    const image = options?.image ?? DEFAULT_IMAGE;
    const name = container_name_for(id);
    const working_directory = compute_container_workspace_path(provider);

    // Requirements detection: run on the primary source directory (detection is
    // per-project; the primary source is the natural anchor). Socket-mount and
    // service prompts fire here — after detection, before container creation.
    const primary_host_path = sources[0].host_path;
    const detected = detect_requirements(primary_host_path, { tool: tool_name });
    const overrides = load_overrides(primary_host_path);
    let merged_requirements = merge_requirements(detected, overrides);

    const socket_result = await resolve_socket_mount(
        primary_host_path,
        merged_requirements,
        { allow_socket_mount: options?.allow_socket_mount, deny_socket_mount: options?.deny_socket_mount },
        options?.prompter ?? null,
    );
    const service_selections = await resolve_services(primary_host_path, merged_requirements, options?.prompter ?? null);
    merged_requirements = merge_service_selections(merged_requirements, service_selections);

    const detected_volume_mounts = build_volume_mounts(merged_requirements, socket_result.approved);
    const detected_environment_variables = build_environment_variables(merged_requirements, detected_volume_mounts, socket_result.approved);

    // Merge detected with caller-provided (Decision 8): volume mount lists are
    // unioned; caller-provided environment variables win on key conflicts so
    // explicit caller intent is never silently overridden. Authentication
    // environment variables (from inject_pre_create_authentication) are NOT
    // stored in the manifest — they are re-injected fresh on every create and
    // resume (security invariant; see inject_pre_create_authentication).
    const resolved_volume_mounts = [...new Set([...detected_volume_mounts, ...(options?.volume_mounts ?? [])])];
    const resolved_environment_variables = { ...detected_environment_variables, ...options?.environment_variables };
    const resolved_npm_packages = merge_npm_packages(merged_requirements.npm_packages, options?.npm_packages ?? []);

    const stale_result = check_stale_image(image, merged_requirements.system_packages.map(r => r.capability));
    if (stale_result.stale) {
        if (stale_result.no_label) {
            logger().warn('Image has no capability tracking. Run patchlab build-image to create a tracked image.');
        } else {
            for (const capability of stale_result.missing) {
                logger().warn(`Image missing detected capability: ${capability}. Run patchlab build-image to update.`);
            }
        }
    }

    const sandbox_directory = build_archive_path(id);
    fs.mkdirSync(sandbox_directory, { recursive: true });

    // Surface the cgroup-unsupported warning before the first podman create in
    // this process. The probe is cached; subsequent creates are free.
    warn_once_if_unsupported();

    // Phase 2 (mutations): create the `patchlab/{id}` branch in each repository,
    // capturing the per-repository baseline commit for dirty repos. Track every
    // successfully-created branch; if any per-repository step fails, force-delete
    // every tracked branch and clear the tracking list so the outer container-
    // cleanup catch doesn't attempt a second rollback on already-deleted branches.
    let baseline_commit_shas: Record<string, string | null>;
    let branch_creation_point_shas: Record<string, string | null>;
    const created_branch_repositories: string[] = [];
    try {
        const phase_2 = execute_phase_2_mutations(
            repositories, id, dirty_repositories, created_branch_repositories);
        baseline_commit_shas = phase_2.baseline_commit_shas;
        branch_creation_point_shas = phase_2.branch_creation_point_shas;
    } catch (error) {
        rollback_phase_2_created_branches(created_branch_repositories, id);
        created_branch_repositories.length = 0;
        fs.rmSync(sandbox_directory, { recursive: true, force: true });
        throw error;
    }

    try {
        return await provision_new_sandbox({
            patchlab_id: id,
            container_name: name,
            sources,
            options,
            provider,
            image,
            tool_name,
            working_directory,
            sandbox_directory,
            baseline_commit_shas,
            branch_creation_point_shas,
            resolved_volume_mounts,
            resolved_environment_variables,
            resolved_npm_packages,
        });
    } catch (error) {
        rollback_failed_create(name, sandbox_directory, id, created_branch_repositories);
        throw error;
    }
}




export interface Resume_Sandbox_Options {
    /** Skip dependency install after the workspace is populated. */
    no_install?: boolean;
    /**
     * Additional context paths to merge with the previous session's `context/`.
     * New entries replace any colliding archive entries from the previous session.
     */
    context_paths?: string[];
    /**
     * Host files or directories to copy into the new sandbox workspace. These
     * are merged with the previous session's workspace-copies archive (new input
     * wins on destination conflict) and restored after the branch tip is applied.
     */
    copy_paths?: Copy_Specification[];
    /**
     * Prompter for interactive confirmations during resume (active-sandbox
     * replacement and oversized-archive gating). `null` in non-interactive
     * contexts: active-sandbox throws; oversized-archive throws via the
     * undefined-callback path in `archive.ts`.
     */
    prompter?: Prompter | null;
    /** Cap on the branch-archive size before the user is asked to confirm. Defaults to 256 MB. */
    max_archive_size_bytes?: number;
    /**
     * Trust-prompt options for per-source manifest gating. CLI passes the
     * --strict-trust / --allow-untrusted-manifests resolution here. The
     * gate fires immediately after per-source registration succeeds and
     * before `get_provider`'s launch-command path is exercised.
     */
    trust_options?: Confirm_Per_Source_Options;
    /**
     * Per-invocation resource-limit overrides parsed from CLI flags on
     * `patchlab resume`. When a field is set here, it wins over the
     * persisted-manifest layer and the runtime defaults. When unset, the
     * persisted value from the most recent prior session is used (or, if
     * absent, the runtime default).
     */
    cli_resource_overrides?: CLI_Limit_Overrides;
    /**
     * User-global and per-source configuration values loaded by the CLI
     * before invoking `resume_sandbox`. See `Create_Sandbox_Options.loaded_configuration`
     * for the full contract — `resume_sandbox` consumes the same value the
     * resolver does, layered below the persisted-manifest layer (which
     * carries the prior session's create-time choices forward).
     */
    loaded_configuration?: Loaded_Configuration;
}

/**
 * Active-sandbox confirmation: if the patchlab already has an existing container
 * (running or stopped), prompt the caller before removing it and creating another.
 * Returns once it's safe to proceed (no container OR the caller confirmed). Throws
 * when the caller declined or did not pass a confirmation hook.
 */
async function confirm_active_sandbox_if_needed(
    previous_manifest: Sandbox_Manifest,
    patchlab_id: string,
    options: Resume_Sandbox_Options | undefined,
): Promise<void> {
    if (!container_exists(previous_manifest.container_name)) {
        return;
    }
    if (options?.prompter == null) {
        throw new Error(
            `Patchlab ${patchlab_id} already has an existing container; `
            + `pass prompter or remove the container first.`
        );
    }
    logger().warn(
        'You have an active sandbox for this patchlab already. '
        + 'Continuing will stop and replace it.',
    );
    const proceed = await options.prompter.confirm('Do you really want to create another? [y/N] ');
    if (!proceed) {
        throw new Error('Resume aborted: user declined to create another sandbox.');
    }
}

/**
 * Best-effort restore of the prior session's tool conversation state. Logs
 * (and swallows) any provider-injection failure so a corrupt or missing
 * state archive doesn't block the resume from completing.
 */
async function restore_previous_session_state(
    provider: ReturnType<typeof get_provider>,
    container_name: string,
    patchlab_id: string,
    previous_session_number: number,
): Promise<void> {
    const previous_session_directory = build_session_path(patchlab_id, previous_session_number);
    try {
        await provider.inject_session_state(container_name, previous_session_directory);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: tool session state injection failed — ${message}`);
    }
}

interface Provision_Resumed_Sandbox_Input {
    patchlab_id: string;
    sandbox_directory: string;
    previous_manifest: Sandbox_Manifest;
    new_container_name: string;
    working_directory: string;
    image: string;
    provider: ReturnType<typeof get_provider>;
    tool_name: string;
    overlay_staging_directory: string;
    options: Resume_Sandbox_Options | undefined;
}

/**
 * Provision the resumed container: build the host-overlay staging directory
 * from files NOT tracked on the patchlab branch, create the container, extract
 * the branch tip into the workspace, overlay the staged host files, initialize
 * the git baseline, then write the new session's manifest and metadata. Throws
 * on failure; the caller's catch path tears down the new container.
 *
 * For multi-source patchlabs we iterate each source: the branch-tip exclusion
 * set is the union of repository-relative paths across all mounted prefixes,
 * and the host overlay copies files from each source's `host_path` into the
 * staging directory at the source's mount path.
 *
 * For `file_copy` providers, authentication is INTENTIONALLY always re-injected
 * on resume regardless of the resumed image's tool_state. Create has a parallel
 * site that DOES short-circuit on `was_authentication_attempted_at_build` —
 * see set_up_image_tier. The asymmetry is deliberate: credentials baked into
 * the image at first-create may have expired or rotated on the host between
 * create and a later resume (OAuth refresh tokens, host re-login, rotated API
 * keys). Resume reads the host's current credentials so a long-lived sandbox
 * doesn't silently run with stale tokens. See design.md Decision 6 and the
 * spec anti-scenario "Sandbox resume always re-injects for file_copy providers
 * regardless of image label" in image-caching.
 */
async function provision_resumed_sandbox(input: Provision_Resumed_Sandbox_Input): Promise<Sandbox_Manifest> {
    const {
        patchlab_id, sandbox_directory, previous_manifest,
        new_container_name, working_directory, image, provider, tool_name,
        overlay_staging_directory, options,
    } = input;

    // Per-source branch-tip file enumeration. The exclusion-set keys are
    // mount-name-relative (matching the container's workspace layout), which
    // is what the overlay step checks. Computed BEFORE container creation so
    // the overlay staging directory is fully prepared first.
    const branch_name = patchlab_branch_name(patchlab_id);
    const branch_files = build_branch_file_set(previous_manifest, branch_name);
    overlay_multi_source_host_files(
        previous_manifest.sources,
        overlay_staging_directory,
        previous_manifest.include_globs,
        previous_manifest.exclude_globs,
        branch_files,
    );

    // Reuse the create-path injection: `inject_pre_create_authentication`
    // runs BEFORE podman-create on both flows. Resume only needs the env-var
    // map; the `authentication_result` payload is for file_copy providers,
    // which resume handles separately downstream via `inject_post_create_authentication`.
    const { extra_environment_variables } = inject_pre_create_authentication(provider, patchlab_id);

    // Resolve resource limits for the resume container. The manifest layer
    // reads from the most-recent prior session's persisted `resource_limits`
    // block (null when the prior session predates this feature). CLI overrides
    // on `patchlab resume` win when present.
    const persisted_limits = read_persisted_resource_limits(patchlab_id);
    const resolved_limits = resolve_resource_limits(
        options?.loaded_configuration ?? EMPTY_LOADED_CONFIGURATION,
        persisted_limits,
        options?.cli_resource_overrides ?? {},
    );
    const limit_create_options = resolved_limits_to_create_options(resolved_limits);

    create_container(new_container_name, image, {
        volume_mounts: previous_manifest.volume_mounts,
        environment_variables: previous_manifest.environment_variables,
        extra_environment_variables: Object.keys(extra_environment_variables).length > 0 ? extra_environment_variables : undefined,
        memory_limit: limit_create_options.memory_limit,
        cpu_limit: limit_create_options.cpu_limit,
        pids_limit: limit_create_options.pids_limit,
        blkio_weight: limit_create_options.blkio_weight,
    });
    start_container(new_container_name);

    if (provider.get_authentication_method() === 'file_copy') {
        provider.inject_authentication({
            sandbox_id: patchlab_id,
            container_name: new_container_name,
        });
    }

    // Order matters: extract the branch tip first (so file modes from the git
    // tree survive intact), then overlay host files without overwriting
    // anything that already exists.
    prepare_workspace(new_container_name, working_directory);
    // Per-source branch-tip export. Each source emits its own
    // `git archive --prefix=<mount_name>/ <branch>[:<source_prefix>]` so the
    // tar lands at the correct mount path with no post-extraction rename.
    // Sources sharing one `repository_root` MUST run sequentially (git's
    // index lock is exclusive per `.git`); across repos serial-or-concurrent
    // is fine. The streaming step is sequential because the container target
    // is a single workspace. Conservative choice: serial across everything.
    const confirm_oversized = build_oversized_confirm(options?.prompter ?? null);
    for (const source of previous_manifest.sources) {
        await export_per_source_branch_tip_to_container(
            source,
            patchlab_id,
            new_container_name,
            working_directory,
            {
                max_size_bytes: options?.max_archive_size_bytes,
                confirm_oversized,
            },
        );
    }
    overlay_into_container(new_container_name, overlay_staging_directory, working_directory);
    initialize_sandbox_git_baseline(new_container_name, working_directory);

    if (!options?.no_install) {
        install_dependencies(new_container_name, working_directory);
    }

    if (previous_manifest.npm_packages && previous_manifest.npm_packages.length > 0) {
        install_npm_packages(new_container_name, previous_manifest.npm_packages, working_directory);
    }

    const updated_manifest: Sandbox_Manifest = {
        ...previous_manifest,
        container_name: new_container_name,
    };
    write_manifest(sandbox_directory, updated_manifest);

    const session_number = write_initial_session_metadata(
        patchlab_id, tool_name, new_container_name, updated_manifest, resolved_limits,
    );

    const previous_session_number = session_number - 1;
    if (previous_session_number >= 1) {
        await restore_previous_session_state(
            provider, new_container_name, patchlab_id, previous_session_number,
        );
    }

    // Merge previous session's context with new --context inputs. The merged
    // set is what the new session will own.
    inject_resume_context(
        patchlab_id,
        session_number,
        previous_session_number,
        new_container_name,
        provider.image_specification.image_home,
        options?.context_paths ?? []
    );

    // Merge previous session's workspace copies with new --copy inputs, archive
    // the full resolved set, then restore into the container workspace. Branch-tip
    // files are skipped (branch tip is authoritative for non-gitignored copies).
    const workspace_copies_merge = merge_resume_workspace_copies(
        build_session_path(patchlab_id, previous_session_number, 'workspace-copies'),
        options?.copy_paths ?? [],
        patchlab_id,
        session_number,
    );
    for (const warning of workspace_copies_merge.warnings) {
        logger().warn(`Warning: ${warning}`);
    }

    restore_workspace_copies(
        new_container_name,
        provider.image_specification.image_home,
        build_session_path(patchlab_id, session_number, 'workspace-copies'),
        branch_files,
    );

    return updated_manifest;
}

/**
 * Resume reachability pre-flight: iterate every repository the patchlab
 * spans (`manifest_repositories(manifest)`) and check two conditions per
 * repository — (1) it is still a git repository at its recorded path, and
 * (2) the `patchlab/{id}` branch exists in it. Accumulate ALL failures
 * (NOT short-circuit) and surface them together so the user can fix every
 * gap in one round-trip. No workspace mutation has occurred at this point.
 */
function assert_every_repository_reachable_for_resume(
    manifest: Sandbox_Manifest,
    patchlab_id: string,
): void {
    const branch = patchlab_branch_name(patchlab_id);
    const failures: { repository_root: string; mode: 'unreachable' | 'branch missing' }[] = [];
    for (const repository_root of manifest_repositories(manifest)) {
        if (!is_git_repository(repository_root)) {
            failures.push({ repository_root, mode: 'unreachable' });
            continue;
        }

        if (!branch_exists(repository_root, branch)) {
            failures.push({ repository_root, mode: 'branch missing' });
        }
    }

    if (failures.length === 0) {
        return;
    }

    const lines = failures.map(({ repository_root, mode }) =>
        `  - ${repository_root} (${mode})`,
    );
    throw new Error(
        `Resume cannot proceed for patchlab ${patchlab_id}: one or more repositories failed `
        + `the reachability pre-flight. The recorded path is shown verbatim; on a partial-resume `
        + `you would skip the listed repos, but partial-resume is rejected — a patchlab is a `
        + `coordinated set across all its repositories. Fix every entry below before re-running:\n`
        + `${lines.join('\n')}`,
    );
}

/**
 * Resume a patchlab in a fresh container by exporting the patchlab branch tip,
 * overlaying untracked host files, and initializing a new sandbox baseline.
 *
 * Workspace is built in two steps (matching the spec):
 *   1. Export the tree at `patchlab/{id}` (preserves modes and symlinks).
 *   2. Overlay host files using the patchlab's original include/exclude globs,
 *      with branch-tip files taking precedence (host files never overwrite).
 *
 * Any prior container associated with the patchlab is removed; a new container
 * is created from the manifest's previously-resolved image.
 */
export async function resume_sandbox(
    patchlab_id: string,
    options?: Resume_Sandbox_Options
): Promise<Sandbox_Manifest> {
    const sandbox_directory = build_archive_path(patchlab_id);
    if (!fs.existsSync(sandbox_directory)) {
        throw new Error(`Patchlab not found: ${patchlab_id}`);
    }

    const previous_manifest = read_manifest(sandbox_directory);

    // Resume reachability pre-flight (task 3.4 / Decision 3): every repository
    // spanned by the patchlab MUST be a git repository at its recorded path
    // AND carry the `patchlab/{id}` branch BEFORE any workspace mutation. The
    // pre-flight accumulates EVERY failure (not short-circuit) so the user
    // sees the full picture in one round-trip.
    assert_every_repository_reachable_for_resume(previous_manifest, patchlab_id);

    // Per-source registration MUST run before `get_provider` so configured
    // tools whose names are only defined under <repository_root>/.patchlab/tools/
    // resolve. Trust verification fires immediately after registration
    // (resume invokes `get_launch_command`, so it's a gated operation). The
    // trust marker keys on the repository root, so two patchlabs from
    // different mounts of the same repository share one marker.
    const previous_repository_roots = manifest_repositories(previous_manifest);
    const per_source_result = register_per_source_manifests(previous_repository_roots);
    await verify_per_source_trust_multi_repository(
        previous_repository_roots,
        per_source_result.manifest_buffers,
        per_source_result.registered_manifests,
        per_source_result.registered_manifest_repositories,
        per_source_result.errors,
        options?.trust_options,
    );

    const tool_name = resolve_manifest_tool(previous_manifest);
    const provider = get_provider(tool_name);

    // Run BEFORE any workspace/container work: fail fast if a required artifact
    // was produced in the prior session but is missing from the archive. Use
    // the latest session that actually has metadata (not next - 1), so a
    // crashed/in-progress metadata-less session directory is not mistaken for
    // the prior session.
    const previous_session_for_check = latest_session_with_metadata(patchlab_id);
    if (previous_session_for_check !== null) {
        check_required_for_resume(patchlab_id, previous_session_for_check, provider);
    }

    await confirm_active_sandbox_if_needed(previous_manifest, patchlab_id, options);
    // Resume is a destructive replace: the new container reuses the SAME
    // deterministic name (container_name_for(patchlab_id) === the previous
    // container's name), so the old container MUST be removed before the new
    // one is created — provisioning the replacement first would collide on the
    // name. If provisioning then fails, the manifest still names the (now
    // removed) container, but no data is lost: the session's work lives on the
    // `patchlab/{id}` branch tip, and re-running `resume` rebuilds from it.
    stop_and_remove_container_best_effort(previous_manifest.container_name);

    // Surface the cgroup-unsupported warning before the resume container is
    // created. Same warn-once latch as the create path.
    warn_once_if_unsupported();

    const new_container_name = container_name_for(patchlab_id);
    const working_directory = compute_container_workspace_path(provider);
    const image = previous_manifest.effective_image ?? previous_manifest.container_image;

    const overlay_staging_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-resume-overlay-'));

    try {
        return await provision_resumed_sandbox({
            patchlab_id,
            sandbox_directory,
            previous_manifest,
            new_container_name,
            working_directory,
            image,
            provider,
            tool_name,
            overlay_staging_directory,
            options,
        });
    } catch (error) {
        stop_and_remove_container_best_effort(new_container_name);
        throw error;
    } finally {
        fs.rmSync(overlay_staging_directory, { recursive: true, force: true });
    }
}
