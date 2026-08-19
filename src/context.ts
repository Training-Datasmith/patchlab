import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build_session_path } from './archive.js';
import { copy_to_container, exec_container } from './container_runtime.js';
import { stage_symlink_within_root } from './symlink_compatibility.js';
import { host_is_case_insensitive } from './path_containment.js';

export interface Resolved_Context_Entry {
    /** Absolute path to the source on the host. */
    source_path: string;
    /** Path relative to `context/` (forward-slashed) — used both in archive and sandbox. */
    archive_relative_path: string;
}

export interface Resolve_Context_Result {
    entries: Resolved_Context_Entry[];
    /** Human-readable warnings emitted during resolution (e.g., conflict skips). */
    warnings: string[];
}

/**
 * Resolve `--context` inputs into archive-bound entries.
 *
 *   - Relative paths preserve their relative structure under `context/`
 *   - Absolute paths use only the filename
 *   - First-wins on archive-path conflicts; later inputs are skipped with a warning
 */
export function resolve_context_paths(
    input_paths: string[],
    base_directory: string = process.cwd()
): Resolve_Context_Result {
    const entries: Resolved_Context_Entry[] = [];
    const warnings: string[] = [];
    const claimed = new Map<string, string>();

    for (const input_path of input_paths) {
        const expanded = expand_user_home(input_path);
        const resolved_source = path.isAbsolute(expanded)
            ? path.resolve(expanded)
            : path.resolve(base_directory, expanded);

        if (!fs.existsSync(resolved_source)) {
            warnings.push(`Context path does not exist; skipping: ${input_path}`);
            continue;
        }

        const archive_relative = compute_archive_relative_path(expanded, base_directory);
        // On a case-insensitive host (Windows/macOS) two inputs differing only
        // in case resolve to the SAME archive file, so fold the conflict key to
        // catch the collision the later copy would otherwise silently win. On a
        // case-sensitive host the key is identity, so genuinely-distinct casings
        // are not over-rejected.
        const conflict_key = host_is_case_insensitive()
            ? archive_relative.toLowerCase()
            : archive_relative;
        const previous_source = claimed.get(conflict_key);
        if (previous_source) {
            warnings.push(
                `Context path conflict: '${input_path}' resolves to '${archive_relative}' `
                + `which is already populated by '${previous_source}'. Skipping the later entry.`
            );
            continue;
        }
        claimed.set(conflict_key, resolved_source);
        entries.push({ source_path: resolved_source, archive_relative_path: archive_relative });
    }

    return { entries, warnings };
}

function expand_user_home(input: string): string {
    if (input === '~') {
        return os.homedir();
    }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}

function compute_archive_relative_path(
    expanded_path: string,
    base_directory: string
): string {
    if (path.isAbsolute(expanded_path)) {
        return path.basename(expanded_path);
    }
    const resolved = path.resolve(base_directory, expanded_path);
    const relative = path.relative(base_directory, resolved);
    if (relative === '' || relative.startsWith('..')) {
        // Outside base directory — fall back to filename only.
        return path.basename(expanded_path);
    }
    return relative.replaceAll('\\', '/');
}

export interface Prompt_File_Staging_Result {
    merged_context_paths: string[];
    container_files: string[];
}

/**
 * Resolve `--prompt-file` paths for staging and OpenCode `--file` argv.
 * Fail-closed: missing paths, directories, and destination collisions with
 * `--context` or other prompt files all throw.
 */
export function resolve_prompt_file_staging(
    prompt_file_paths: readonly string[],
    context_paths: readonly string[],
    image_home: string,
    base_directory: string = process.cwd(),
): Prompt_File_Staging_Result {
    if (prompt_file_paths.length === 0) {
        return {
            merged_context_paths: [...context_paths],
            container_files: [],
        };
    }

    const context_resolution = resolve_context_paths([...context_paths], base_directory);
    const claimed = new Map<string, string>();
    for (const entry of context_resolution.entries) {
        const conflict_key = host_is_case_insensitive()
            ? entry.archive_relative_path.toLowerCase()
            : entry.archive_relative_path;
        claimed.set(conflict_key, entry.source_path);
    }

    const container_files: string[] = [];
    const prompt_host_paths: string[] = [];

    for (const input_path of prompt_file_paths) {
        const expanded = expand_user_home(input_path);
        const resolved_source = path.isAbsolute(expanded)
            ? path.resolve(expanded)
            : path.resolve(base_directory, expanded);

        if (!fs.existsSync(resolved_source)) {
            throw new Prompt_File_Staging_Error(`--prompt-file path does not exist: ${input_path}`);
        }
        const stat = fs.lstatSync(resolved_source);
        if (stat.isDirectory()) {
            throw new Prompt_File_Staging_Error(`--prompt-file must be a file, not a directory: ${input_path}`);
        }

        const archive_relative = compute_archive_relative_path(expanded, base_directory);
        const conflict_key = host_is_case_insensitive()
            ? archive_relative.toLowerCase()
            : archive_relative;
        const previous_source = claimed.get(conflict_key);
        if (previous_source !== undefined && previous_source !== resolved_source) {
            throw new Prompt_File_Staging_Error(
                `--prompt-file '${input_path}' resolves to context destination '${archive_relative}' `
                + `which is already used by '${previous_source}'.`,
            );
        }
        claimed.set(conflict_key, resolved_source);
        prompt_host_paths.push(resolved_source);
        container_files.push(`${image_home}/context/${archive_relative}`);
    }

    const merged = [...context_paths];
    for (const host_path of prompt_host_paths) {
        if (!merged.includes(host_path)) {
            merged.push(host_path);
        }
    }

    return { merged_context_paths: merged, container_files };
}

export class Prompt_File_Staging_Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Prompt_File_Staging_Error';
    }
}

/**
 * Copy resolved context entries into the session's `context/` directory in the archive.
 * Directory entries are copied recursively. The destination is created on demand.
 */
export function copy_context_to_archive(
    entries: Resolved_Context_Entry[],
    patchlab_id: string,
    session_number: number
): void {
    if (entries.length === 0) {
        return;
    }
    const archive_root = build_session_path(patchlab_id, session_number, 'context');
    fs.mkdirSync(archive_root, { recursive: true });

    for (const entry of entries) {
        const destination = path.join(archive_root, entry.archive_relative_path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        // A real directory bounds its own symlinks; a symlink (or file) entry is
        // bounded by its parent. Decided by lstat so a symlink-to-directory is
        // treated as a link, not a directory.
        const containing_root = fs.lstatSync(entry.source_path).isDirectory()
            ? entry.source_path
            : path.dirname(entry.source_path);
        copy_path_recursively(entry.source_path, destination, containing_root);
    }
}

/**
 * Copy a session's archived `context/` directory into the running container at
 * `$HOME/context/` (sibling to `$HOME/workspace/`). Idempotent — safe to call
 * after a previous overlay; later calls overwrite earlier files.
 */
export function copy_context_to_container(
    container_name: string,
    image_home: string,
    archive_context_directory: string
): void {
    if (!fs.existsSync(archive_context_directory)) {
        return;
    }
    if (fs.readdirSync(archive_context_directory).length === 0) {
        return;
    }

    const container_context = `${image_home}/context`;
    exec_container(container_name, ['mkdir', '-p', container_context]);
    copy_to_container(container_name, archive_context_directory + '/.', container_context);
}

/**
 * Build a merged set of context entries by starting from the previous session's
 * archive `context/` and overlaying new `--context` inputs. New entries replace
 * any colliding archive entries; the caller is informed via `warnings`.
 */
export interface Merge_Resume_Context_Result {
    entries: Resolved_Context_Entry[];
    warnings: string[];
}

export function merge_resume_context(
    previous_session_context_directory: string | null,
    new_inputs: string[],
    base_directory: string = process.cwd()
): Merge_Resume_Context_Result {
    const new_resolution = resolve_context_paths(new_inputs, base_directory);
    const new_paths = new Set(new_resolution.entries.map((entry) => entry.archive_relative_path));
    const merged: Resolved_Context_Entry[] = [];
    const warnings = [...new_resolution.warnings];

    if (previous_session_context_directory && fs.existsSync(previous_session_context_directory)) {
        for (const relative_path of list_relative_files(previous_session_context_directory)) {
            if (new_paths.has(relative_path)) {
                warnings.push(
                    `Context override: '${relative_path}' from previous session is replaced by --context input.`
                );
                continue;
            }
            merged.push({
                source_path: path.join(previous_session_context_directory, relative_path),
                archive_relative_path: relative_path,
            });
        }
    }

    merged.push(...new_resolution.entries);

    // Surface basename collisions across different archive paths — the entries don't
    // overwrite each other in the filesystem, but a tool that searches by basename
    // (or a user scanning $HOME/context/ flat) may be surprised to find duplicates.
    warnings.push(...detect_basename_collisions(merged));

    return { entries: merged, warnings };
}

function detect_basename_collisions(entries: Resolved_Context_Entry[]): string[] {
    const paths_by_basename = new Map<string, string[]>();
    for (const entry of entries) {
        const basename = path.basename(entry.archive_relative_path);
        const existing = paths_by_basename.get(basename) ?? [];
        existing.push(entry.archive_relative_path);
        paths_by_basename.set(basename, existing);
    }

    const warnings: string[] = [];
    for (const [basename, paths] of paths_by_basename) {
        if (paths.length > 1) {
            warnings.push(
                `Context bundle has multiple files named '${basename}' at different paths: `
                + `${paths.join(', ')}. Tools that search by basename may pick the wrong one.`
            );
        }
    }

    return warnings;
}

export function copy_path_recursively(
    source: string,
    destination: string,
    containing_root: string,
): void {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const child of fs.readdirSync(source)) {
            copy_path_recursively(
                path.join(source, child),
                path.join(destination, child),
                containing_root,
            );
        }
        return;
    }
    if (stat.isSymbolicLink()) {
        try {
            fs.unlinkSync(destination);
        } catch (error) {
            // ENOENT means there was nothing at `destination` to clear out
            // before the symlink write — the happy path. Any other code
            // (EACCES, EBUSY, EISDIR, EPERM) would block the symlink write
            // that follows, so surface it now with the precise error
            // instead of letting the downstream call fail with a vaguer one.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        stage_symlink_within_root(source, destination, containing_root, path.basename(source));
        return;
    }
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
}

function list_relative_files(root: string): string[] {
    const results: string[] = [];
    walk(root, '', results);
    return results;
}

function walk(root: string, prefix: string, accumulator: string[]): void {
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
        const next = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            walk(root, next, accumulator);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            accumulator.push(next);
        }
    }
}
