import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { get_runtime_binary, runtime_host_tmpdir } from '../container_runtime.js';
import { patchlab_branch_name } from './naming.js';
import { branch_exists, patchlab_branch_exists } from './predicates.js';
import type { Source_Specification } from '../manifest.js';
import { safe_unlink } from '../safe_filesystem.js';

/** Default cap on branch-archive size before the user is prompted. 256 MiB. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export interface Branch_Export_Options {
    /** Size cap before the caller is asked to confirm transfer. Defaults to 256 MB. */
    max_size_bytes?: number;
    /**
     * Invoked when the archive exceeds `max_size_bytes`. Returning true proceeds with
     * the transfer; returning false aborts. When omitted entirely, oversized archives
     * fail non-interactively with a clear message.
     */
    confirm_oversized?: (size_bytes: number) => Promise<boolean> | boolean;
}

/**
 * Returns `true` when `git ls-tree -r --name-only <branch>:<prefix>` reports
 * at least one tracked path under `prefix`. Used by `probe_branch_archive`
 * to drop pathspecs that would cause `git archive` to exit 128 with
 * "pathspec did not match any files."
 *
 * Returns `false` for the expected empty-subtree errors ("not a tree object",
 * "Not a valid object name") — those mean the prefix legitimately has no
 * tracked files at the branch tip. Rethrows any other failure (spawn error,
 * ENOBUFS, repository corruption) so the caller does not silently drop a
 * prefix and produce an archive that omits real content.
 */
function prefix_has_files_at_branch_tip(
    repository_root: string,
    branch: string,
    prefix: string,
): boolean {
    try {
        const stdout = execFileSync('git', ['ls-tree', '-r', '--name-only', `${branch}:${prefix}`], {
            cwd: repository_root,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
            env: { ...process.env, LC_ALL: 'C' },
            maxBuffer: 256 * 1024 * 1024,
        });
        return stdout.split('\n').some((line) => line.trim() !== '');
    } catch (ls_tree_error) {
        const stderr_buffer = (ls_tree_error as { stderr?: Buffer | string }).stderr;
        const stderr_text = typeof stderr_buffer === 'string'
            ? stderr_buffer
            : stderr_buffer?.toString('utf-8') ?? '';
        if (is_empty_subtree_archive_error(stderr_text)) {
            return false;
        }

        throw ls_tree_error;
    }
}

/**
 * Write a multi-pathspec `git archive --format=tar <branch> -- <prefix>/...`
 * to a host temp file (or the bare `git archive <branch>` when the only
 * prefix is empty, i.e. single-source-at-repository-root). Returns the file path
 * and its size so the caller can decide whether to proceed before piping
 * the tar into a destination process.
 *
 * Empty-match handling: `git archive` exits 128 if ANY supplied pathspec
 * matches no files. This collides with the spec scenario "Resume with
 * pathspec matching zero files at branch tip" where a session may have
 * deleted every file under a mounted prefix — resume must NOT fail. We
 * pre-filter the prefix list via `git ls-tree` and only pass prefixes
 * that have at least one matching path. If ALL supplied prefixes are
 * empty matches, we synthesize an empty tar DIRECTLY (1024 zero bytes — the
 * canonical two-block end-of-archive marker) rather than invoking `git
 * archive` with no pathspecs, which would archive the entire tree.
 */
function probe_branch_archive(
    repository_root: string,
    patchlab_id: string,
    source_prefixes: string[]
): { size_bytes: number; host_path: string } {
    const branch = patchlab_branch_name(patchlab_id);
    if (!patchlab_branch_exists(repository_root, patchlab_id)) {
        throw new Error(
            `Patchlab branch ${branch} does not exist in ${repository_root}.`
        );
    }

    const host_path = path.join(
        runtime_host_tmpdir(),
        `patchlab-archive-${patchlab_id}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.tar`
    );

    // The bare-branch form fires when the only supplied prefix is the empty
    // string (source IS repository root). Otherwise build a pathspec list — git
    // appends `/` to every directory pathspec so the archive matches the
    // entire subtree under each prefix.
    const non_empty_prefixes = source_prefixes.filter((prefix) => prefix !== '');

    // Pre-filter the prefixes against `git ls-tree` so we only invoke
    // `git archive` with pathspecs that have at least one match (avoids the
    // exit-128 no-match failure).
    const matching_prefixes = non_empty_prefixes.length === 0
        ? non_empty_prefixes
        : non_empty_prefixes.filter((prefix) => prefix_has_files_at_branch_tip(repository_root, branch, prefix));

    // If the caller asked for non-empty prefixes but none of them match
    // (e.g., a session deleted every file under the mounted subpaths),
    // emit an empty tar so the container-side `tar -xf` is a no-op. We
    // produce the empty tar by writing 1024 zero bytes (the canonical
    // tar end-of-archive marker — two zero-filled 512-byte blocks).
    if (non_empty_prefixes.length > 0 && matching_prefixes.length === 0) {
        fs.writeFileSync(host_path, Buffer.alloc(1024));
        return { size_bytes: 1024, host_path };
    }

    const archive_arguments = ['-c', 'core.autocrlf=false', 'archive', '--format=tar', branch];
    if (matching_prefixes.length > 0) {
        archive_arguments.push('--');
        for (const prefix of matching_prefixes) {
            archive_arguments.push(`${prefix}/`);
        }
    }

    const handle = fs.openSync(host_path, 'w');
    try {
        // -c core.autocrlf=false: when the host repository enables autocrlf (common on
        // Windows), `git archive` would otherwise rewrite line endings to CRLF in the
        // tar. The container expects byte-for-byte content, so suppress the conversion.
        execFileSync(
            'git',
            archive_arguments,
            {
                cwd: repository_root,
                stdio: ['ignore', handle, 'pipe'],
            }
        );
    } finally {
        fs.closeSync(handle);
    }

    const size_bytes = fs.statSync(host_path).size;
    return { size_bytes, host_path };
}

async function gate_archive_size(
    size_bytes: number,
    options: Branch_Export_Options | undefined
): Promise<void> {
    const cap = options?.max_size_bytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    if (size_bytes <= cap) {
        return;
    }

    if (!options?.confirm_oversized) {
        throw new Error(
            `Branch archive is ${size_bytes} bytes (cap: ${cap}). `
            + `Re-run interactively to confirm, or pass max_size_bytes higher.`
        );
    }

    const proceed = await options.confirm_oversized(size_bytes);
    if (!proceed) {
        throw new Error('Branch export aborted at user request.');
    }
}

/**
 * Export the tree at the tip of `patchlab/{id}` into `destination_directory` on the host.
 *
 * Uses `git archive | tar -x` to preserve file modes (executable bits) and symlinks
 * exactly as recorded in the git tree. The destination directory must exist.
 *
 * Note: on hosts whose filesystem does not track POSIX mode bits (Windows/NTFS),
 * the executable bit will be lost. For container-bound exports prefer
 * `export_per_source_branch_tip_to_container` (the multi-source path also
 * handles the single-source case by passing an empty `source_prefix`).
 */
export async function export_branch_tip(
    repository_root: string,
    patchlab_id: string,
    destination_directory: string,
    source_prefixes: string[] = [''],
    options?: Branch_Export_Options
): Promise<void> {
    if (!fs.existsSync(destination_directory)) {
        throw new Error(`Destination directory does not exist: ${destination_directory}`);
    }

    const probe = probe_branch_archive(repository_root, patchlab_id, source_prefixes);
    try {
        await gate_archive_size(probe.size_bytes, options);
        execFileSync('tar', ['-xf', probe.host_path, '-C', destination_directory], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } finally {
        safe_unlink(probe.host_path);
    }
}

/**
 * Classify a `git archive` failure's stderr as the legitimate "empty subtree"
 * case (the prefix matches no tracked content at the branch tip) versus a
 * real failure (permissions, missing binary, transient I/O, etc.).
 *
 * The empty-subtree case is the only failure `export_per_source_branch_tip_to_container`
 * should swallow: it is the spec-supported scenario where a session deleted
 * every file under a mounted prefix. Every other failure SHALL surface so
 * the user sees the real cause instead of silently receiving an empty mount
 * on resume.
 *
 * The two markers we accept are the only messages git emits for "this object
 * does not exist as a tree at the requested revision":
 *   - "fatal: not a tree object" — the prefix resolves to a non-tree.
 *   - "fatal: Not a valid object name '<branch>:<prefix>'" — the prefix does
 *     not exist in the branch tip's tree at all (the common case after a
 *     session deletes every file under the prefix, since empty trees aren't
 *     stored in git).
 */
export function is_empty_subtree_archive_error(stderr: string): boolean {
    return /^fatal: (?:not a tree|Not a valid object name)/m.test(stderr);
}

/**
 * Per-source variant: stream the subtree at `patchlab/{id}:<source_prefix>`
 * in `repository_root` to the container's `destination_directory`, prefixing
 * every entry with `<mount_name>/` via git's native `--prefix` flag. The
 * three argv forms (per multi-source-extraction Decision 3):
 *
 *   - `source_prefix` non-empty AND `mount_name` non-empty: subtree archive
 *     `git archive --prefix=<mount_name>/ <branch>:<source_prefix>`.
 *   - `source_prefix` empty AND `mount_name` non-empty: whole-tree archive
 *     mounted under a name: `git archive --prefix=<mount_name>/ <branch>`.
 *   - `source_prefix === "" && mount_name === ""`: bare whole-tree archive
 *     `git archive <branch>` (the legacy flat-workspace layout).
 *
 * No post-extraction copy/rename step: container-side entries land at
 * `${HOME}/workspace/<mount_name>/...` directly.
 *
 * An empty subtree (the source's `source_prefix` matches no files at the
 * branch tip — e.g., a session deleted every file there) produces an empty
 * tar; `tar -xf` of an empty tar is a no-op and resume continues normally.
 *
 * Caller is responsible for ordering: per-source archives against the SAME
 * `repository_root` SHALL run sequentially (git's index lock is per-`.git`,
 * exclusive); across repositories they MAY run concurrently. The streaming
 * step into the container is always sequential.
 */
export async function export_per_source_branch_tip_to_container(
    source: Source_Specification,
    patchlab_id: string,
    container_name: string,
    destination_directory: string,
    options?: Branch_Export_Options,
): Promise<void> {
    const branch = patchlab_branch_name(patchlab_id);
    if (!branch_exists(source.repository_root, branch)) {
        throw new Error(
            `Patchlab branch ${branch} does not exist in ${source.repository_root}.`,
        );
    }

    const host_path = path.join(
        runtime_host_tmpdir(),
        `patchlab-archive-${patchlab_id}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.tar`,
    );

    const archive_arguments = [
        '-c', 'core.autocrlf=false',
        'archive', '--format=tar',
    ];
    if (source.mount_name !== '') {
        archive_arguments.push(`--prefix=${source.mount_name}/`);
    }
    archive_arguments.push(
        source.source_prefix === ''
            ? branch
            : `${branch}:${source.source_prefix}`,
    );

    const handle = fs.openSync(host_path, 'w');
    try {
        try {
            execFileSync('git', archive_arguments, {
                cwd: source.repository_root,
                // Force the C locale so the empty-subtree classification below
                // (is_empty_subtree_archive_error) matches git's English stderr
                // wording regardless of the host's configured locale.
                env: { ...process.env, LC_ALL: 'C' },
                stdio: ['ignore', handle, 'pipe'],
            });
        } catch (archive_error) {
            const stderr_buffer = (archive_error as { stderr?: Buffer | string }).stderr;
            const stderr_text = typeof stderr_buffer === 'string'
                ? stderr_buffer
                : stderr_buffer?.toString('utf-8') ?? '';
            if (is_empty_subtree_archive_error(stderr_text)) {
                // `git archive <branch>:<source_prefix>` on a subtree that
                // matches no files at the branch tip (a session deleted every
                // file under the prefix, or the prefix was never a tracked
                // tree at this revision) exits non-zero with "fatal: not a
                // tree" or "fatal: Not a valid object name". Treat this as
                // the empty-tar case — truncate any partial output and write
                // a canonical empty tar (1024 zero bytes = two zero-filled
                // 512-byte end-of-archive blocks).
                fs.ftruncateSync(handle, 0);
                fs.writeSync(handle, Buffer.alloc(1024), 0, 1024, 0);
            } else {
                const target = source.source_prefix === ''
                    ? branch
                    : `${branch}:${source.source_prefix}`;
                const detail = stderr_text.trim() || (archive_error as Error).message;
                throw new Error(
                    `git archive failed for ${target} in ${source.repository_root}: ${detail}`,
                );
            }
        }
    } finally {
        fs.closeSync(handle);
    }

    const size_bytes = fs.statSync(host_path).size;
    try {
        await gate_archive_size(size_bytes, options);
        await stream_archive_to_container(host_path, container_name, destination_directory);
    } finally {
        safe_unlink(host_path);
    }
}

function stream_archive_to_container(
    host_archive_path: string,
    container_name: string,
    destination_directory: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(
            get_runtime_binary(),
            ['exec', '-i', container_name, 'tar', '-xf', '-', '-C', destination_directory],
            { stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const reader = fs.createReadStream(host_archive_path);

        // Tear down both ends on any failure: a tar exit-non-zero would
        // otherwise leave the host read stream open (leaked fd) piping into a
        // dead stdin, and a reader error would orphan the `podman exec tar`
        // child. destroy()/kill() are idempotent after the peer has exited.
        const fail = (error: Error): void => {
            reader.destroy();
            child.kill();
            reject(error);
        };

        const errors: Buffer[] = [];
        child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
        // Killing the child mid-pipe makes stdin emit EPIPE; absorb it so it
        // does not surface as an unhandled 'error' event.
        child.stdin.on('error', () => {});
        child.on('error', fail);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            fail(new Error(
                `tar extraction failed in container (exit ${code}): `
                + Buffer.concat(errors).toString('utf-8')
            ));
        });

        reader.on('error', fail);
        reader.pipe(child.stdin);
    });
}
