import * as path from 'node:path';
import { logger } from '../../logger.js';
import { is_path_within } from '../../path_containment.js';
import type { Prompter } from '../../prompts.js';
import { compute_trusted_manifests_hash, format_warning } from './trust_hash.js';
import { read_trust_marker, write_trust_marker } from './trust_marker.js';
import type {
    Configured_Tool_Provider_Manifest,
    Manifest_Parse_Error,
} from './types.js';

// --- Per-source trust prompt -----------------------------------------------

/**
 * Combine `--strict-trust` / `--allow-untrusted-manifests` CLI flag values
 * with their environment-variable equivalents into a `Confirm_Per_Source_Options`
 * payload. Either surface (flag or env) being set turns the corresponding
 * option on; both surfaces being set on opposing axes throws
 * `Conflicting_Flags_Error` before any discovery / registration runs.
 *
 * Lives here (not in `src/cli.ts`) so unit tests can import it without
 * triggering Commander's argv parsing at module load.
 */
export function resolve_trust_options_from(
    flags: { strict_trust: boolean; allow_untrusted: boolean },
    env: NodeJS.ProcessEnv,
): Confirm_Per_Source_Options {
    const strict_trust = flags.strict_trust || env.PATCHLAB_STRICT_TRUST === '1';
    const allow_untrusted = flags.allow_untrusted || env.PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS === '1';
    if (strict_trust && allow_untrusted) {
        throw new Conflicting_Flags_Error();
    }

    return { strict_trust, allow_untrusted_manifests: allow_untrusted };
}

export class Conflicting_Flags_Error extends Error {
    constructor() {
        super(
            'Conflicting flags: --strict-trust and --allow-untrusted-manifests cannot both be set. '
            + 'Pick one — --strict-trust to enforce strict-by-default non-TTY behavior, or '
            + '--allow-untrusted-manifests to opt into proceeding without prompting in non-TTY contexts.',
        );

        this.name = 'Conflicting_Flags_Error';
    }
}

export class Trust_Declined_Error extends Error {
    constructor(reason: string) {
        super(`Per-source manifests not trusted: ${reason}`);
        this.name = 'Trust_Declined_Error';
    }
}

export interface Confirm_Per_Source_Options {
    /**
     * Explicit reaffirmation of the strict-by-default non-TTY behavior. Has
     * no effect in TTY mode. Semantically a no-op when set alone (default
     * non-TTY behavior is already abort); exists for scripts/configs that
     * want to declare the trust posture explicitly. Mutually exclusive with
     * `allow_untrusted_manifests`.
     */
    strict_trust?: boolean;
    /**
     * Override the non-TTY abort. The caller is acknowledging the security
     * risk and asking the runtime to proceed without prompting. Has no effect
     * in TTY mode. Marker is NOT written — the next interactive run still
     * prompts. Mutually exclusive with `strict_trust`.
     */
    allow_untrusted_manifests?: boolean;
    /**
     * Per-line warning sink. Defaults to `logger().warn(line)` (which writes to
     * stderr with the standard trailing-newline rule per the Logger interface).
     * Tests pass capture buffers — caller-supplied sinks bypass the Logger
     * entirely, so test capture is unaffected by `set_logger` swaps.
     */
    output_warn?: (line: string) => void;
    /**
     * Prompter used for the interactive trust dialog. `null` (or absent)
     * signals non-interactive context: the policy throws `Trust_Declined_Error`
     * unless `allow_untrusted_manifests` is set. Tests pass a `Fake_Prompter`
     * to drive the accept/decline branches without a real readline.
     */
    prompter?: Prompter | null;
}

function build_minimum_disclosure_lines(
    repository_root: string,
    registered_manifests: Configured_Tool_Provider_Manifest[],
    parse_errors: Manifest_Parse_Error[],
): string[] {
    const lines: string[] = [];
    lines.push(`Per-source manifests found at ${repository_root}/.patchlab/tools/.`,
        'Confirming trust authorizes the listed launch commands to run in your patchlab sandbox.',
        '');

    let uses_home_expansion = false;
    for (const manifest of registered_manifests) {
        lines.push(
            `  Manifest: ${manifest.name} (${manifest.display_name})`,
            `    launch_command: ${JSON.stringify(manifest.launch_command)}`,
            `    base_image: ${manifest.base_image}`,
            `    authentication.method: ${manifest.authentication.method}`);

        if (manifest.authentication.method === 'file_copy') {
            const copies = manifest.authentication.copies;
            const hosts = copies.map((copy) => copy.host);
            lines.push(`    authentication.copies hosts: ${hosts.join(', ')}`);
            uses_home_expansion = uses_home_expansion || copies.some((copy) => copy.uses_home_expansion);
        }

        const install_lines = manifest.dockerfile?.install ?? [];
        if (install_lines.length === 0) {
            lines.push(`    dockerfile.install: (none)`);
        } else {
            lines.push(`    dockerfile.install: ${install_lines.length} package(s): ${install_lines.join(', ')}`);
        }

        lines.push('');
    }

    for (const error of parse_errors) {
        lines.push(format_warning({
            operation: 'per_source_trust',
            provider_name: path.basename(error.manifest_path),
            action: 'rejected',
            target: error.field_path === '' ? error.manifest_path : error.field_path,
            reason: error.reason,
        }));
    }

    if (uses_home_expansion) {
        lines.push(
            '  Note: at least one host path uses `~` or `$HOME`. The expanded value depends on the '
            + 'current user — your trust decision is host-machine-dependent and may not reproduce on a '
            + "teammate's machine.",
        );
    }

    return lines;
}

/**
 * Render the trust warning and gate the operation per the TTY / flag matrix.
 * Always emits the warning to stderr first (interactive or not) — the warning
 * is what makes the user aware that there's content to trust. Then:
 *
 *   - TTY → call `confirm()`; on yes, write marker and return; on no, throw
 *     `Trust_Declined_Error`. Opt-out flags are ignored in TTY mode.
 *   - non-TTY + default OR `--strict-trust` → throw `Trust_Declined_Error`,
 *     no marker written. Closes the npm-postinstall attack vector.
 *   - non-TTY + `--allow-untrusted-manifests` → return without writing marker.
 *     The explicit CI opt-in for legitimate per-source use.
 *   - Both flags set → throw `Conflicting_Flags_Error` BEFORE rendering the
 *     warning (the conflict is a configuration mistake; abort early).
 *
 * `trusted_hash` is the hash of the manifests as they exist NOW (per the
 * shared-buffer reader). On TTY confirm the marker is written with this
 * exact hash so subsequent runs short-circuit.
 */
export async function confirm_per_source_manifests(
    repository_root: string,
    registered_manifests: Configured_Tool_Provider_Manifest[],
    parse_errors: Manifest_Parse_Error[],
    trusted_hash: string,
    options?: Confirm_Per_Source_Options,
): Promise<void> {
    const strict_trust = options?.strict_trust ?? false;
    const allow_untrusted = options?.allow_untrusted_manifests ?? false;
    if (strict_trust && allow_untrusted) {
        throw new Conflicting_Flags_Error();
    }

    const output_warn = options?.output_warn ?? ((line: string) => logger().warn(line));
    const prompter = options?.prompter ?? null;

    for (const line of build_minimum_disclosure_lines(repository_root, registered_manifests, parse_errors)) {
        output_warn(line);
    }

    if (prompter === null) {
        if (allow_untrusted) {
            return;
        }

        throw new Trust_Declined_Error(
            'non-interactive context and trust prompt cannot run. '
            + 'Set --allow-untrusted-manifests (or PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS=1) to proceed without prompting.',
        );
    }

    const confirmed = await prompter.confirm(`Trust these per-source manifests for ${repository_root}? [y/N] `);
    if (!confirmed) {
        throw new Trust_Declined_Error('user declined the trust prompt');
    }

    write_trust_marker(repository_root, trusted_hash);
}

/**
 * Operation-gate entry point: verify that the per-source manifests at
 * `source_path` are trusted (marker matches current hash). When not trusted,
 * delegate to `confirm_per_source_manifests` which prompts the user (TTY) or
 * aborts (non-TTY default / `--strict-trust`) or proceeds without marker
 * (non-TTY + `--allow-untrusted-manifests`).
 *
 * No-ops when `manifest_buffers` is empty (no manifests to trust). The
 * caller MUST pass the same buffer map that `register_per_source_manifests`
 * returned so hash and parse share bytes (closes the TOCTOU gap).
 */
export async function verify_per_source_trust(
    repository_root: string,
    manifest_buffers: Map<string, Buffer>,
    registered_manifests: Configured_Tool_Provider_Manifest[],
    parse_errors: Manifest_Parse_Error[],
    options?: Confirm_Per_Source_Options,
): Promise<void> {
    if (manifest_buffers.size === 0) {
        return;
    }

    const current_hash = compute_trusted_manifests_hash(manifest_buffers);
    const marker_hash = read_trust_marker(repository_root);
    if (marker_hash === current_hash) {
        return;
    }

    await confirm_per_source_manifests(
        repository_root,
        registered_manifests,
        parse_errors,
        current_hash,
        options,
    );
}

/**
 * Multi-repository trust verification fan-out (multi-source-trust task 5.1-5.8).
 *
 * For each repository that contributes at least one per-source manifest, run
 * the single-repository `verify_per_source_trust` independently. Prompts run
 * sequentially in `manifest_repositories(manifest)` order — the caller passes
 * `repository_roots` already in that order. A decline of ANY repository's prompt
 * aborts the entire verification with `Trust_Declined_Error`; the earlier
 * repos' markers (if any were written by their `confirm_per_source_manifests`
 * call) remain persisted by design (the user's confirmation was real).
 *
 * A repository that contributes NO manifests skips the trust check silently
 * (no manifests → nothing to confirm). Both `manifest_buffers` AND `parse_errors`
 * are partitioned per repository by prefix-matching each manifest path against
 * the repository root — registration writes each manifest path as
 * `<repository_root>/.patchlab/tools/<file>`, so the prefix check is unambiguous.
 * Partitioning the errors keeps each repository's trust prompt scoped to its own
 * diagnostics: confirming repo A no longer surfaces rejected-manifest warnings
 * that originated in repo B, which could otherwise alarm or mislead the user
 * about what they are approving.
 */
export async function verify_per_source_trust_multi_repository(
    repository_roots: readonly string[],
    manifest_buffers: Map<string, Buffer>,
    registered_manifests: readonly Configured_Tool_Provider_Manifest[],
    registered_manifest_repositories: readonly string[],
    parse_errors: Manifest_Parse_Error[],
    options?: Confirm_Per_Source_Options,
): Promise<void> {
    if (manifest_buffers.size === 0) {
        return;
    }

    for (const repository_root of repository_roots) {
        const per_repository_buffers = partition_buffers_by_repository(manifest_buffers, repository_root);
        if (per_repository_buffers.size === 0) {
            continue;
        }

        const per_repository_manifests = registered_manifests.filter(
            (_manifest, index) => registered_manifest_repositories[index] === repository_root,
        );
        const per_repository_parse_errors = partition_parse_errors_by_repository(parse_errors, repository_root);
        await verify_per_source_trust(
            repository_root,
            per_repository_buffers,
            per_repository_manifests,
            per_repository_parse_errors,
            options,
        );
    }
}

/**
 * Filter `parse_errors` to those whose manifest lives under the given
 * repository's `.patchlab/tools/` directory, using the same host-aware
 * containment check as `partition_buffers_by_repository`. Keeps each
 * repository's trust prompt scoped to its own rejected manifests.
 */
function partition_parse_errors_by_repository(
    parse_errors: Manifest_Parse_Error[],
    repository_root: string,
): Manifest_Parse_Error[] {
    const tools_directory = path.join(repository_root, '.patchlab', 'tools');
    return parse_errors.filter((error) => is_path_within(error.manifest_path, tools_directory));
}

/**
 * Filter a manifest-buffer map to entries under the given repository's
 * `.patchlab/tools/` directory. Containment uses the shared, host-aware
 * `is_path_within` (unifies separators and folds case on case-insensitive
 * hosts — Windows AND macOS); a manifest path is always strictly beneath the
 * tools directory, so equal-or-under behaves the same as strictly-under here.
 */
function partition_buffers_by_repository(
    manifest_buffers: Map<string, Buffer>,
    repository_root: string,
): Map<string, Buffer> {
    const tools_directory = path.join(repository_root, '.patchlab', 'tools');
    const result = new Map<string, Buffer>();
    for (const [manifest_path, buffer] of manifest_buffers) {
        if (is_path_within(manifest_path, tools_directory)) {
            result.set(manifest_path, buffer);
        }
    }

    return result;
}

/**
 * Probe whether the per-source manifests at `source_path` are currently
 * unconfirmed (marker missing or stale). Used by `list-tools` to annotate
 * per-source entries with `[unconfirmed]` without firing the trust prompt.
 *
 * Returns `false` when there are no manifests to trust (empty buffer map).
 */
export function is_per_source_unconfirmed(
    repository_root: string,
    manifest_buffers: Map<string, Buffer>,
): boolean {
    if (manifest_buffers.size === 0) {
        return false;
    }

    const current_hash = compute_trusted_manifests_hash(manifest_buffers);
    const marker_hash = read_trust_marker(repository_root);
    return marker_hash !== current_hash;
}
