import * as fs from 'node:fs';
import * as path from 'node:path';
import { is_path_within } from './path_containment.js';
import { logger } from './logger.js';

/**
 * Stage a single symlink at `destination`, refusing (warn-and-skip) any whose
 * target escapes `containing_root` — a relative `..` climb out of the tree, or
 * an absolute target that resolves outside the root (e.g. `/proc/self/environ`,
 * `/etc/passwd`). A relative in-root target is replicated as a link where the
 * platform allows; an absolute in-root target is content-dereferenced (a
 * host-absolute path is meaningless inside the container, so its bytes are
 * copied rather than a dangling link replicated). Either way the realpath leg of
 * `copy_symlink_with_dereference_fallback` keeps materialized bytes inside the
 * root as defense-in-depth.
 *
 * This gate intentionally differs from `is_symlink_target_within_root` (used by
 * `find_escape_symlinks`): that check refuses ALL absolute targets because the
 * links it guards travel VERBATIM into the container via `podman cp`, where a
 * host-absolute path resolves against the container's filesystem and host
 * containment proves nothing. Staging never lets an absolute link reach the
 * container — it dereferences to host content — so an in-root absolute target is
 * safe here.
 *
 * Returns true when the link was staged, false when it was refused.
 */
export function stage_symlink_within_root(
    symlink_source: string,
    destination: string,
    containing_root: string,
    relative_label: string,
): boolean {
    const target = fs.readlinkSync(symlink_source);
    // Resolve absolute and relative targets uniformly (an absolute target
    // resolves to itself) and require host-containment. Out-of-root targets —
    // absolute or `..`-escaping — are refused; in-root ones proceed to be
    // replicated (relative) or dereferenced (absolute) by the copier below.
    const resolved_target = path.resolve(path.dirname(symlink_source), target);
    if (!is_path_within(resolved_target, path.resolve(containing_root))) {
        logger().warn(
            `Skipping symlink with target outside the source tree: ${relative_label} `
            + `(root ${containing_root}). Such links can leak host or container-internal `
            + `files (e.g., /proc/self/environ) to the AI tool inside the sandbox.`
        );

        return false;
    }
    copy_symlink_with_dereference_fallback(symlink_source, destination, containing_root);

    return true;
}

/**
 * Replicate a symlink at `destination` pointing at the same target as `symlink_source`.
 *
 * On Windows, `fs.symlinkSync` requires either Administrator privileges or Developer
 * Mode enabled; without either it fails with `EPERM`. Some filesystems also reject
 * symlinks with `ENOTSUP`. In those cases this helper falls back to dereferencing the
 * source symlink and copying the target file's content as a regular file. The link
 * semantics are lost on the fallback path, but content survives — which is the right
 * trade-off for a build/copy step that would otherwise abort the entire operation.
 *
 * The fallback materializes HOST-resolved bytes (unlike a replicated link, which
 * resolves inside the container), so it self-defends: the dereferenced target's
 * real path must stay within `containing_root`, and a target directory is copied
 * link-by-link rather than with a blanket `dereference` so every NESTED link is
 * re-checked too. A target that escapes the root — directly, via a symlink chain,
 * or through a nested link — is refused, not copied. Callers should still run the
 * lexical gate (`stage_symlink_within_root`) first; this realpath leg is
 * defense-in-depth for chains the lexical check cannot see.
 *
 * Replication-vs-dereference is decided by the target shape: a RELATIVE target is
 * portable (it resolves the same wherever the tree lands), so it is replicated as
 * a link where the platform allows. An ABSOLUTE target is NOT portable — a
 * host-absolute path means nothing inside the container and would dangle or
 * mis-resolve if replicated — so its content is always dereferenced (subject to
 * the realpath-containment check below).
 *
 * Broken symlinks (target does not exist) are recorded as a placeholder file rather
 * than aborting; the caller can decide whether to treat that as significant.
 */
export function copy_symlink_with_dereference_fallback(
    symlink_source: string,
    destination: string,
    containing_root: string,
): void {
    const target = fs.readlinkSync(symlink_source);

    // Relative targets replicate as links (portable); absolute targets fall
    // straight through to the content-dereference path below.
    if (!path.isAbsolute(target)) {
        try {
            fs.symlinkSync(target, destination);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EPERM' && code !== 'ENOTSUP') {
                throw error;
            }
        }
    }

    // Dereferenced fallback. Resolve the target relative to the symlink's parent
    // (an absolute target resolves to itself).
    const resolved_target = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(symlink_source), target);

    if (!fs.existsSync(resolved_target)) {
        fs.writeFileSync(
            destination,
            `Broken symlink (target missing): ${target}\n`,
            'utf-8'
        );
        return;
    }

    // Realpath containment: the caller's lexical gate only inspected THIS link's
    // immediate target. A chain (in-root link → in-root link → out-of-root) or a
    // nested link inside a target directory could still reach outside the root, so
    // resolve real paths and require the target stay within `containing_root`
    // before copying any host bytes. Fail closed if the real path cannot resolve.
    const real_root = fs.realpathSync(containing_root);
    let real_target: string;
    try {
        real_target = fs.realpathSync(resolved_target);
    } catch (_unresolvable_target) {
        fs.writeFileSync(
            destination,
            `Skipped symlink (target real path unresolvable): ${target}\n`,
            'utf-8'
        );

        return;
    }

    if (!is_path_within(real_target, real_root)) {
        logger().warn(
            `Skipping symlink whose dereferenced target escapes the source tree: `
            + `${target} (root ${containing_root}).`
        );
        fs.writeFileSync(
            destination,
            `Skipped symlink (target outside permitted root): ${target}\n`,
            'utf-8'
        );

        return;
    }

    const target_stat = fs.statSync(real_target);
    if (target_stat.isDirectory()) {
        copy_directory_dereferencing_within_root(real_target, destination, real_root);
        return;
    }

    fs.copyFileSync(real_target, destination);
    fs.chmodSync(destination, target_stat.mode);
}

/**
 * Recursively copy `source_directory` into `destination`, dereferencing nested
 * symlinks one at a time through `copy_symlink_with_dereference_fallback` so each
 * is re-checked against `real_root`. Used by the dereference fallback in place of
 * a blanket `fs.cpSync({ dereference: true })`, which would follow every nested
 * link — including out-of-root ones — with no containment check.
 */
function copy_directory_dereferencing_within_root(
    source_directory: string,
    destination: string,
    real_root: string,
): void {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source_directory, { withFileTypes: true })) {
        const child_source = path.join(source_directory, entry.name);
        const child_destination = path.join(destination, entry.name);
        if (entry.isSymbolicLink()) {
            copy_symlink_with_dereference_fallback(child_source, child_destination, real_root);
        } else if (entry.isDirectory()) {
            copy_directory_dereferencing_within_root(child_source, child_destination, real_root);
        } else {
            fs.copyFileSync(child_source, child_destination);
            fs.chmodSync(child_destination, fs.statSync(child_source).mode);
        }
    }
}

/**
 * Walk `archive_root` recursively and return relative paths of any symlinks whose
 * target would resolve outside `archive_root`. Used to refuse unsafe archive content
 * before handing it to a copy step (e.g. `podman cp`) that would otherwise extract
 * the link as-is and let it escape inside the destination filesystem.
 */
export function find_escape_symlinks(archive_root: string): string[] {
    const findings: string[] = [];
    walk_for_escape_symlinks(archive_root, '', findings);
    return findings;
}

function walk_for_escape_symlinks(
    archive_root: string,
    prefix: string,
    findings: string[]
): void {
    const directory = prefix === '' ? archive_root : path.join(archive_root, prefix);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (readdir_error) {
        const code = (readdir_error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            // Subdirectory disappeared between parent readdir and our readdir
            // (benign race — nothing can be hiding there). The root-missing
            // case is dead code: callers check `existsSync` before invoking
            // `find_escape_symlinks`. Safe to skip.
            return;
        }

        // EACCES/EPERM or any other error: the directory exists but is
        // unreadable, meaning escape symlinks inside it would be invisible to
        // this scan. Rethrow so the caller aborts injection rather than
        // proceeding with incomplete security information.
        throw readdir_error;
    }

    for (const entry of entries) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const full_path = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
            if (!is_symlink_target_within_root(full_path, archive_root)) {
                findings.push(relative);
            }
            continue;
        }

        if (entry.isDirectory()) {
            walk_for_escape_symlinks(archive_root, relative, findings);
        }
    }
}

/**
 * Returns false when the symlink at `symlink_source` would resolve, lexically, to a
 * path outside `containing_root` — either via an absolute target (e.g. `/proc/self/environ`,
 * `/etc/passwd`) or via a relative target that escapes the root with `..`.
 *
 * Used to refuse materializing source-overlay symlinks whose targets could surface
 * container-internal files (env vars set on the container, /proc state, etc.) to the
 * AI tool inside the sandbox.
 *
 * Lexical resolution only — we deliberately do not follow further symlinks on the
 * host because the resolution we care about happens inside the container, where the
 * host's filesystem chain does not apply.
 */
export function is_symlink_target_within_root(
    symlink_source: string,
    containing_root: string
): boolean {
    const target = fs.readlinkSync(symlink_source);

    if (path.isAbsolute(target)) {
        return false;
    }

    const resolved_target = path.resolve(path.dirname(symlink_source), target);
    const resolved_root = path.resolve(containing_root);

    // Delegate the prefix comparison to the shared, host-aware `is_path_within`
    // (separator + case-folding handled centrally) rather than rolling a
    // byte-exact `startsWith` here — a case-insensitive host would otherwise
    // false-reject a legitimately-contained target that differs only in case.
    return is_path_within(resolved_target, resolved_root);
}
