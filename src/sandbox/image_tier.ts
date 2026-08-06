/**
 * Image-tier resolution and tag computation. Owns the patchlab tag-trio
 * (`<base>`, `<base>-<tool>` for installed, `<base>-<tool>-auth` for
 * authenticated), the cache-lookup chain that decides which cached image to
 * start from, and the post-create commit-site dispatch that lands the right
 * label at the right tag.
 *
 * Extracted from `src/sandbox/provisioning.ts` (cluster 1 of the 2370-line file). Pure
 * functions over arguments — no module-level state. Consumers in
 * `src/sandbox/provisioning.ts` re-import the three exported symbols by name.
 *
 * Tests: [test/unit/effective-image.test.ts](../../test/unit/effective-image.test.ts),
 * [test/unit/tool-state-three-values.test.ts](../../test/unit/tool-state-three-values.test.ts),
 * [test/unit/tool-state-tag-form-invariants.test.ts](../../test/unit/tool-state-tag-form-invariants.test.ts),
 * [test/unit/legacy-authenticated-label.test.ts](../../test/unit/legacy-authenticated-label.test.ts).
 */
import {
    commit_container,
    get_image_tool_state,
    image_exists,
    install_package,
    is_patchlab_compatible_image,
    start_container,
    stop_container,
    was_authentication_attempted_at_build,
    type Tool_State,
} from '../podman.js';
import { logger } from '../logger.js';
import type { Authentication_Result, Tool_Provider } from '../tools/types.js';

/**
 * Narrow option slot accepted by `resolve_effective_image` and
 * `set_up_image_tier`. The full `Create_Sandbox_Options` interface (defined in
 * `src/sandbox/provisioning.ts`) satisfies this structurally — callers can pass it directly
 * without conversion.
 */
export interface Image_Tier_Options {
    force_rebuild?: boolean;
}

/**
 * Pull the per-manifest content hash off a provider when one is present.
 * Built-in providers report `undefined`; configured providers carry the hash
 * as a string. Duck-typing keeps `image_tier.ts` from depending on the
 * `configured_provider/` subsystem, which would pull the full configured-provider
 * synthesis machinery into the image-resolution path for the sake of one
 * optional string field.
 */
function manifest_hash_of(provider: Tool_Provider): string | undefined {
    const candidate = provider as unknown as { manifest_hash?: unknown };
    return typeof candidate.manifest_hash === 'string' ? candidate.manifest_hash : undefined;
}

/**
 * Normalize an input image reference to the patchlab-namespaced base tag
 * `patchlab/<base>:<version>`. The output is GUARANTEED to contain a `:`
 * separating the repository segment from the tag segment — this invariant
 * is what lets `compute_authenticated_tag` and `compute_installed_tag` use
 * a single-line regex replacement without an else branch for tagless input.
 *
 * Inputs that already start with `patchlab/` are returned as-is when they
 * carry a `:` tag, or with `:latest` appended when they don't (the
 * `patchlab/foo` edge case).
 */
function compute_base_tag(image: string): string {
    if (image.startsWith('patchlab/')) {
        return image.includes(':') ? image : `${image}:latest`;
    }
    return `patchlab/${image.replace(/[:@]/g, '-')}:latest`;
}

/**
 * Compute the tag form for an image where authentication was actually injected
 * — `patchlab/<base>-<tool>-auth:latest` for built-ins, or
 * `patchlab/<base>-<tool>-<hash>-auth:latest` for configured providers (when
 * `hash` is supplied). Paired with the `authenticated` per-tool label at commit
 * time. For images that were built but where no authentication was injected
 * (e.g., `'none'`-method providers, or `'environment_variables'` providers
 * whose declared variables were unset at build time), use
 * `compute_installed_tag` instead.
 *
 * The `tool` argument is REQUIRED — callers that want the base tag use
 * `compute_base_tag`. The `image` argument MUST be in `<repository>:<tag>`
 * form (callers normalize via `compute_base_tag` first); the helper assumes
 * a `:` is present and does NOT defensively handle tagless input.
 *
 * The optional `hash` argument is the configured-provider manifest content
 * hash (8 hex chars, computed by `compute_manifest_hash` in
 * `src/tools/configured_provider/trust_hash.ts`). Built-ins MUST NOT supply it;
 * configured-provider callers MUST. The hash component falls between `<tool>`
 * and the `-auth` suffix.
 */
function compute_authenticated_tag(image: string, tool: string, hash?: string): string {
    const suffix = hash === undefined ? `${tool}-auth` : `${tool}-${hash}-auth`;
    return image.replace(/:([^:]*)$/, `-${suffix}:$1`);
}

/**
 * Compute the tag form for an image where the tool is installed but no
 * authentication was injected — `patchlab/<base>-<tool>:latest` for built-ins,
 * or `patchlab/<base>-<tool>-<hash>:latest` for configured providers. Paired
 * with the `installed` per-tool label at commit time. For images where
 * authentication WAS injected, use `compute_authenticated_tag`.
 *
 * Same input-shape contract as `compute_authenticated_tag`: `image` MUST be
 * in `<repository>:<tag>` form. `tool` is REQUIRED. The optional `hash`
 * argument is the configured-provider manifest content hash; built-ins MUST
 * NOT supply it.
 */
function compute_installed_tag(image: string, tool: string, hash?: string): string {
    const suffix = hash === undefined ? tool : `${tool}-${hash}`;
    return image.replace(/:([^:]*)$/, `-${suffix}:$1`);
}

export interface Resolved_Image {
    effective_image: string;
    /**
     * Per-tool state of the resolved image. One of the four `Tool_State`
     * values — see [src/podman.ts](../podman.ts) for the docstring on each.
     * Consumers reading this field must distinguish between two semantically
     * different questions:
     *   - "Did auth run when this image was built?" → use
     *     `was_authentication_attempted_at_build(tool_state)` (true for both
     *     `'authenticated'` and `'ready'`).
     *   - "Are credentials in the image bytes?" → use the strict
     *     `tool_state === 'authenticated'` check (true for `'authenticated'`
     *     only; `'ready'` images carry no credentials).
     */
    tool_state: Tool_State;
    is_patchlab_compatible: boolean;
    /**
     * The patchlab base tag derived from the ORIGINAL input image, NOT from
     * `effective_image`. When a cache hit returns the auth-tag in
     * `effective_image`, this field still names the underlying base. Downstream
     * `set_up_image_tier` uses this to compute the auth-tag for any re-commit
     * step, avoiding the bug where `compute_base_tag(auth_tag) → auth_tag` and
     * then `compute_authenticated_tag(auth_tag, tool)` would produce a doubled
     * `<tool>-auth-<tool>-auth` suffix.
     */
    base_tag: string;
}

/**
 * Resolve the best cached image to start from, using per-tool state labels.
 *
 * The lookup chain probes two tag forms in priority order: auth-tag first
 * (most-installed state), then installed-tag, then base, then `'absent'`.
 * Each tag-form probe enforces a tag-form-must-match-label consistency check:
 * an auth-tag image with `'installed'` label OR an installed-tag image with
 * `'authenticated'` label is treated as a cache MISS and the lookup continues
 * down the chain. The check is the migration affordance for orphaned
 * pre-cleanup images — existing `<base>-<tool>-auth:latest` artifacts with
 * label `'installed'` (created by the misnomer-era code path for
 * `'environment_variables'`-method providers when their variables were unset)
 * MUST NOT be reused.
 */
export function resolve_effective_image(
    image: string,
    tool: string,
    provider: Tool_Provider,
    options?: Image_Tier_Options,
): Resolved_Image {
    const hash = manifest_hash_of(provider);
    const base_tag = compute_base_tag(image);

    // Force rebuild: start from the raw image regardless of cache
    if (options?.force_rebuild) {
        return { effective_image: image, tool_state: 'absent', is_patchlab_compatible: false, base_tag };
    }

    // Check the original image's per-tool state. If the user passed an
    // image that already carries per-tool state (`authenticated` or
    // `installed`), short-circuit the cache-lookup chain — the image IS
    // its own cached form, and probing derived tags would compute
    // doubled-suffix forms (e.g., `<base>-<tool>-<tool>-auth:latest`)
    // that miss anyway.
    const original_tool_state = get_image_tool_state(image, tool);
    if (original_tool_state !== 'absent') {
        return { effective_image: image, tool_state: original_tool_state, is_patchlab_compatible: true, base_tag };
    }

    // Auth-tag probe. Tag-form-must-match-label: both `'authenticated'` (file_copy,
    // credentials in image bytes) and `'ready'` (env-var, auth ran at build,
    // credentials supplied at runtime) count as a hit at the `-auth` tag.
    // An auth-tag with `'installed'` label is an orphan from the pre-cleanup
    // misnomer era and is treated as a miss so the lookup falls through to
    // the installed-tag probe. The returned `tool_state` preserves the
    // distinction (downstream consumers that care about "credentials in image
    // bytes" still check the strict literal).
    const authentication_tag = compute_authenticated_tag(base_tag, tool, hash);
    if (image_exists(authentication_tag)) {
        const authentication_state = get_image_tool_state(authentication_tag, tool);
        if (was_authentication_attempted_at_build(authentication_state)) {
            logger().info(`Using cached auth-injected image: ${authentication_tag} (tool.${tool}=${authentication_state})`);
            return {
                effective_image: authentication_tag,
                tool_state: authentication_state,
                is_patchlab_compatible: true,
                base_tag,
            };
        }
    }

    // Installed-tag probe. Tag-form-must-match-label in reverse: only
    // `'installed'` counts as a hit. An installed-tag with `'authenticated'`
    // OR `'ready'` label is inconsistent state (both are auth-attempted
    // states that don't belong at the no-auth tag) — treat as a miss and
    // continue to base.
    const installed_tag = compute_installed_tag(base_tag, tool, hash);
    if (image_exists(installed_tag)) {
        const installed_state = get_image_tool_state(installed_tag, tool);
        if (installed_state === 'installed') {
            logger().info(`Using cached installed image: ${installed_tag}`);
            return {
                effective_image: installed_tag,
                tool_state: 'installed',
                is_patchlab_compatible: true,
                base_tag,
            };
        }
    }

    // Configured-provider hash miss: do NOT fall through to the unrelated
    // no-hash base-tag — that tag may carry an `installed`/`authenticated`
    // label from a different built-in tool's commit. Per-manifest-hash
    // isolation is finer-grained than per-tool isolation; silently inheriting
    // state from a base-tag commit would reuse stale layers. Report `'absent'`
    // so `set_up_image_tier` triggers a clean rebuild.
    if (hash !== undefined) {
        return {
            effective_image: image,
            tool_state: 'absent',
            is_patchlab_compatible: is_patchlab_compatible_image(image),
            base_tag,
        };
    }

    // Base-tag probe. Patchlab-compatible image without per-tool state;
    // typical outcome is `absent` and we fall through to the original.
    if (image_exists(base_tag)) {
        const base_state = get_image_tool_state(base_tag, tool);
        if (base_state !== 'absent') {
            logger().info(`Using cached base image: ${base_tag}`);
            return { effective_image: base_tag, tool_state: base_state, is_patchlab_compatible: true, base_tag };
        }
    }

    // Fall back to original image
    return {
        effective_image: image,
        tool_state: original_tool_state,
        is_patchlab_compatible: is_patchlab_compatible_image(image),
        base_tag,
    };
}

/**
 * Commit the running container `name` to `tag` with `labels`. The container is
 * stopped for the commit and ALWAYS restarted afterward — even if the commit
 * throws — so a commit failure (disk full, podman error) never leaves the
 * sandbox container stopped. The commit error still propagates once the
 * container is back up.
 */
function commit_running_container(name: string, tag: string, labels: Record<string, string>): void {
    stop_container(name);
    let commit_error: unknown;
    try {
        commit_container(name, tag, labels);
    } catch (error) {
        commit_error = error;
    }

    // Always attempt the restart. If the commit already failed, the commit
    // error is the root cause (e.g. disk full) — surface a restart failure as a
    // warning and let the commit error propagate, rather than letting the
    // restart error mask it. If the commit succeeded, a restart failure IS the
    // error to raise (the container is left stopped).
    try {
        start_container(name);
    } catch (start_error) {
        if (commit_error === undefined) {
            throw start_error;
        }

        logger().warn(start_error instanceof Error ? start_error : new Error(String(start_error)));
    }

    if (commit_error !== undefined) {
        throw commit_error;
    }
}

/** Set up the image tier: install git for non-patchlab images, commit with per-tool labels.
 *  Authentication injection is NOT done here — it is owned by create_sandbox().
 *
 *  The commit step chooses the tag form and label based on `authentication_result.type`:
 *  - `'file_copy'` → auth-tag with `authenticated` label (credentials baked into image bytes);
 *  - `'environment_variables'` → auth-tag with `ready` label (auth ran at build, credentials
 *    still supplied at create-time via env var);
 *  - `'none'` (including no-injection-called for `'none'`-method providers) → installed-tag
 *    with `installed` label.
 *
 *  Returns the updated effective_image tag.
 */
export function set_up_image_tier(
    name: string,
    effective_image: string,
    image_resolution: Resolved_Image,
    tool: string,
    authentication_result: Authentication_Result,
    provider: Tool_Provider,
    options?: Image_Tier_Options,
): string {
    const hash = manifest_hash_of(provider);
    // Read the base tag from `image_resolution` rather than recomputing from
    // `effective_image`, which may already be the auth-tag when the cache
    // returned a hit. Recomputing from the auth-tag would re-suffix it on
    // `compute_authenticated_tag` below and produce a doubled `<tool>-auth-
    // <tool>-auth` tag.
    const base_tag = image_resolution.base_tag;

    if (!image_resolution.is_patchlab_compatible) {
        install_package(name, 'git');
        if (!image_exists(base_tag) || options?.force_rebuild) {
            commit_running_container(name, base_tag, {
                'biz.ecartz.patchlab.compatible': 'true',
            });
            logger().info(`Upgraded to base patchlab image: ${base_tag}`);
        }
        effective_image = base_tag;
    }

    // Commit-skip: cache hit at the auth-tag — already correctly tagged, no
    // commit needed. Both `'authenticated'` (file_copy, credentials in image
    // bytes) and `'ready'` (env-var, auth ran at build but credentials passed
    // at runtime) satisfy "input image already at the auth tag," so either
    // label value short-circuits the commit.
    if (was_authentication_attempted_at_build(image_resolution.tool_state)) {
        return effective_image;
    }

    // Selection keyed off `authentication_result.type` (the OUTPUT of
    // `inject_authentication` — what auth actually did at build time), not
    // the provider's declared method. The three result-type discriminants
    // map one-to-one to the three non-`'absent'` Tool_State values.
    let authentication_label: Tool_State;
    if (authentication_result.type === 'none') {
        authentication_label = 'installed';
    } else if (authentication_result.type === 'file_copy') {
        authentication_label = 'authenticated';
    } else { // 'environment_variables'
        authentication_label = 'ready';
    }
    const target_tag = authentication_label === 'installed'
        ? compute_installed_tag(base_tag, tool, hash)
        : compute_authenticated_tag(base_tag, tool, hash);

    // Cache hit at the installed-tag AND injection still produced no auth —
    // already correctly tagged, no commit needed.
    if (image_resolution.tool_state === 'installed' && authentication_label === 'installed') {
        return effective_image;
    }

    // Commit when: target tag doesn't exist, force_rebuild, OR the existing
    // tag's label doesn't match what we want to write. The label-mismatch
    // branch overwrites pre-cleanup misnomer-era orphans (e.g., an existing
    // auth-tag with `installed` label) with a correctly-labeled fresh commit.
    const existing_state = image_exists(target_tag) ? get_image_tool_state(target_tag, tool) : 'absent';
    if (existing_state !== authentication_label || options?.force_rebuild) {
        commit_running_container(name, target_tag, {
            'biz.ecartz.patchlab.compatible': 'true',
            [`biz.ecartz.patchlab.tool.${tool}`]: authentication_label,
        });
        logger().info(`Cached image saved: ${target_tag} (tool.${tool}=${authentication_label})`);
    }

    return target_tag;
}
