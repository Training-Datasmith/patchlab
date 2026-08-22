/**
 * Workspace staging — every host→container file movement that
 * `provision_new_sandbox` and `provision_resumed_sandbox` need to populate the
 * container's working directory. Two sub-concerns live here because they share
 * `resolve_files`:
 *
 *   - **Create path**: wipe-and-fresh-copy host sources into the workspace
 *     (`copy_multi_source_files`), install dependencies and npm packages
 *     (`install_dependencies`, `install_npm_packages`), and snapshot the
 *     result as the git baseline (`initialize_sandbox_git_baseline`).
 *   - **Resume path**: stage host files that are NOT already covered by the
 *     patchlab branch tip (`overlay_multi_source_host_files` and its three
 *     internal helpers), then copy the staging directory into the container
 *     (`prepare_workspace` + `overlay_into_container`).
 *
 * Extracted from `src/sandbox/provisioning.ts` (clusters 3 and 4 of the 2370-line file,
 * merged because `resolve_files` was their only cross-cluster coupling). Pure
 * functions over arguments — no module-level state.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { globSync } from 'glob';
import picomatch from 'picomatch';
import {
    CONTAINER_WORKING_DIR,
    copy_into_workspace,
    copy_to_container,
    exec_container,
    fix_workspace_ownership_if_needed,
    runtime_host_tmpdir,
} from '../container_runtime.js';
import { copy_path_recursively } from '../context.js';
import { stage_symlink_within_root } from '../symlink_compatibility.js';
import { logger } from '../logger.js';
import { is_path_within } from '../path_containment.js';
import { parse_file_as_json } from '../json_validators.js';
import type { Source_Specification } from '../manifest.js';
import type { Npm_Package_Requirement } from '../detect/index.js';
import type { Copy_Specification } from './workspace_copies.js';

/**
 * File patterns that almost always carry secrets. Excluded from sandbox source by
 * default even when `.gitignore` would already exclude them, because a committed
 * secret (accidentally `git add`ed) would otherwise be copied into the workspace.
 * Pass `include_secret_files: true` to opt out.
 */
export const DEFAULT_SECRET_EXCLUDES = [
    '**/.env',
    '**/.env.*',
    '**/.envrc',
    '**/*.pem',
    '**/*.key',
    '**/.netrc',
    '**/.aws/credentials',
    '**/id_rsa',
    '**/id_dsa',
    '**/id_ecdsa',
    '**/id_ed25519',
    '**/.ssh/**',
    '**/.gnupg/**',
];

/**
 * Narrow option slot accepted by `resolve_files`, `copy_multi_source_files`,
 * and the host-overlay path. The full `Create_Sandbox_Options` interface
 * defined in `src/sandbox/provisioning.ts` satisfies this structurally, so callers can
 * pass it directly.
 */
interface Resolve_Files_Options {
    include?: string[];
    exclude?: string[];
    include_secret_files?: boolean;
    allow_submodules?: boolean;
}

/**
 * Run `git ls-files` in `source_path` and return the list of files that git
 * would include (tracked files plus untracked files not excluded by
 * `.gitignore`). Returns `null` when `source_path` is not inside a git
 * repository, allowing the caller to fall back to glob.
 */
function try_git_ls_files(source_path: string): string[] | null {
    try {
        const output = execSync(
            'git ls-files --cached --others --exclude-standard',
            { cwd: source_path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        return output.split('\n').filter(Boolean);
    } catch {
        return null;
    }
}

/**
 * Post-filter a file list produced by `try_git_ls_files` using the same
 * include/exclude/secret rules that the glob path applies via glob options.
 */
function apply_filters(files: string[], options?: Resolve_Files_Options): string[] {
    const user_ignore = options?.exclude ?? [];
    const ignore_patterns = options?.include_secret_files
        ? user_ignore
        : [...DEFAULT_SECRET_EXCLUDES, ...user_ignore];

    let result = files;

    if (options?.include && options.include.length > 0) {
        const include_matchers = options.include.map((pattern) => picomatch(pattern, { dot: true }));
        result = result.filter((file) => include_matchers.some((matcher) => matcher(file)));
    }

    if (ignore_patterns.length > 0) {
        const ignore_matchers = ignore_patterns.map((pattern) => picomatch(pattern, { dot: true }));
        result = result.filter((file) => !ignore_matchers.some((matcher) => matcher(file)));
    }

    return result;
}

function resolve_files(
    source_path: string,
    options?: Resolve_Files_Options
): string[] {
    const git_files = try_git_ls_files(source_path);
    if (git_files !== null) {
        return apply_filters(git_files, options);
    }

    const cwd = path.resolve(source_path);
    let patterns = ['**/*'];
    if (options?.include && options.include.length > 0) {
        patterns = options.include;
    }
    const user_ignore = options?.exclude ?? [];
    const ignore = options?.include_secret_files
        ? user_ignore
        : [...DEFAULT_SECRET_EXCLUDES, ...user_ignore];
    return globSync(patterns, { cwd, nodir: true, dot: true, ignore });
}

/**
 * Read the configured URL for a submodule from the parent repository's
 * `.gitmodules`. Returns `null` when the entry is absent or unreadable.
 *
 * Limitation: assumes the submodule name equals its path (the common case).
 * Repositories where the name and path differ will fall back to the configured
 * remote URL during initialization.
 */
function read_submodule_url(parent_path: string, submodule_path: string): string | null {
    try {
        return execFileSync(
            'git',
            ['config', '-f', '.gitmodules', `submodule.${submodule_path}.url`],
            { cwd: parent_path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim() || null;
    } catch {
        return null;
    }
}

/**
 * Return the commit SHA recorded for a submodule in the parent repository's
 * HEAD tree (the gitlink object). Returns `null` when the parent has no
 * commits yet or the path is not a gitlink.
 */
function read_recorded_submodule_sha(parent_path: string, submodule_relative_path: string): string | null {
    try {
        return execFileSync(
            'git',
            ['rev-parse', `HEAD:${submodule_relative_path}`],
            { cwd: parent_path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim() || null;
    } catch {
        return null;
    }
}

/**
 * Find a source whose directory basename matches the repository name portion of
 * `configured_url` (case-insensitive, `.git` suffix stripped) AND whose local
 * git history contains `recorded_sha`. The SHA check disambiguates repositories
 * that share a name — a local source that does not have the recorded commit is
 * rejected even if the name matches. When `recorded_sha` is `null` (parent has
 * no commits or the path is not a gitlink), name matching alone is used.
 * Returns the first qualifying source, or `undefined` when none qualify.
 */
function find_local_source_matching_url(
    configured_url: string,
    recorded_sha: string | null,
    all_sources: Source_Specification[],
): Source_Specification | undefined {
    const repository_name = configured_url.split('/').pop()?.replace(/\.git$/i, '') ?? '';
    if (!repository_name) {
        return undefined;
    }

    return all_sources.find((source) => {
        if (path.basename(source.host_path).toLowerCase() !== repository_name.toLowerCase()) {
            return false;
        }

        if (!recorded_sha) {
            return true;
        }

        try {
            execFileSync('git', ['cat-file', '-e', recorded_sha], {
                cwd: source.host_path,
                stdio: ['ignore', 'ignore', 'ignore'],
            });
            return true;
        } catch {
            return false;
        }
    });
}

/**
 * Ensure a gitlink directory is populated so its files can be copied. Prefers
 * cloning from a matching local source (same repository name, different remote)
 * to avoid network round-trips and to capture local-only branches. Falls back
 * to `git submodule update --init` from the configured URL when no local match
 * exists. Returns `true` when the directory is ready for file extraction.
 */
function initialize_submodule(
    parent_path: string,
    submodule_relative_path: string,
    submodule_directory: string,
    all_sources: Source_Specification[],
): boolean {
    const configured_url = read_submodule_url(parent_path, submodule_relative_path);
    const recorded_sha = read_recorded_submodule_sha(parent_path, submodule_relative_path);
    const local_source = configured_url
        ? find_local_source_matching_url(configured_url, recorded_sha, all_sources)
        : undefined;

    if (local_source) {
        try {
            execFileSync(
                'git', ['clone', local_source.host_path, submodule_directory],
                { stdio: ['ignore', 'ignore', 'ignore'] },
            );
            logger().info(
                `Initialized submodule ${submodule_relative_path} from local `
                + `${path.basename(local_source.host_path)}.`,
            );
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(
                `Warning: local clone for submodule ${submodule_relative_path} failed — ${message}; `
                + `trying configured URL.`,
            );
        }
    }

    if (configured_url) {
        try {
            execFileSync(
                'git', ['submodule', 'update', '--init', '--', submodule_relative_path],
                { cwd: parent_path, stdio: ['ignore', 'ignore', 'ignore'] },
            );
            logger().info(`Initialized submodule ${submodule_relative_path} from ${configured_url}.`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(
                `Warning: could not initialize submodule ${submodule_relative_path} — ${message}; skipping.`,
            );
        }
    } else {
        logger().warn(
            `Warning: submodule ${submodule_relative_path} has no configured URL and no matching `
            + `local source; skipping.`,
        );
    }

    return false;
}

/**
 * Copy the tracked files from a gitlink (submodule) directory into the staging
 * area under the submodule's relative path. Initializes the submodule first if
 * the directory is not yet a git repository. Applies the same include/exclude
 * and symlink-escape guards as the parent copy loop.
 */
function stage_submodule(
    parent_host_path: string,
    submodule_relative_path: string,
    all_sources: Source_Specification[],
    options: Resolve_Files_Options,
    staging_directory: string,
    real_root: string,
): void {
    const submodule_directory = path.join(parent_host_path, submodule_relative_path);
    const is_git_repository = fs.existsSync(path.join(submodule_directory, '.git'));

    if (!is_git_repository) {
        const ready = initialize_submodule(
            parent_host_path, submodule_relative_path, submodule_directory, all_sources,
        );
        if (!ready) {
            return;
        }
    }

    const submodule_files = try_git_ls_files(submodule_directory);
    if (!submodule_files) {
        return;
    }

    const filtered_files = apply_filters(submodule_files, options);
    for (const submodule_file of filtered_files) {
        const source = path.join(submodule_directory, submodule_file);
        const relative_path = path.join(submodule_relative_path, submodule_file);
        const destination = path.join(staging_directory, relative_path);

        let real_source: string;
        try {
            real_source = fs.realpathSync(source);
        } catch {
            logger().warn(`Skipping unresolvable path in submodule: ${relative_path}.`);
            continue;
        }

        if (!is_path_within(real_source, real_root)) {
            logger().warn(`Skipping submodule path escaping source tree: ${relative_path}.`);
            continue;
        }

        if (!fs.statSync(real_source).isFile()) {
            stage_submodule(
                submodule_directory, submodule_file, all_sources, options,
                path.join(staging_directory, submodule_relative_path), real_root,
            );
            continue;
        }

        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
    }
}

/**
 * Copy each source's files into the container workspace.
 *
 * For every source in `sources`:
 *   - Empty `mount_name` (single-source-at-repository-root with no override)
 *     lands files at `${working_directory}/` directly.
 *   - Non-empty `mount_name` lands files at `${working_directory}/<mount_name>/`.
 *     For single-repository patchlabs without an explicit `--mount`, the writer
 *     defaults `mount_name` to `source_prefix` so the container layout is
 *     unchanged from subpaths' behavior; for multi-repository patchlabs the
 *     user-supplied `--mount` value determines the path.
 *
 * The workspace directory is wiped and recreated once before the copy loop;
 * the per-source copy loop then iterates and uses one staging directory per
 * source so the include/exclude globs apply against each source's host path.
 */
/**
 * Copy a single source-relative file into the staging directory, applying
 * symlink-escape and non-file guards. When the path resolves to a directory
 * (a gitlink / submodule entry) and `allow_submodules` is set, delegates to
 * `stage_submodule` instead of skipping.
 */
function stage_one_source_file(
    entry: Source_Specification,
    relative_path: string,
    all_sources: Source_Specification[],
    options: Resolve_Files_Options | undefined,
    staging_directory: string,
    real_root: string,
): void {
    const source = path.join(entry.host_path, relative_path);
    // Resolve symlinks across the WHOLE path (leaf AND any intermediate
    // directory) and skip anything whose real location escapes the source tree,
    // before copyFileSync dereferences it. A leaf symlink — or a regular file
    // reached THROUGH a symlinked parent directory — that points at an absolute
    // host path (e.g. /etc/passwd) would otherwise be copied into the workspace
    // and exposed to the AI tool. realpath-based, so an escape hidden behind an
    // intermediate symlink is caught too.
    let real_source: string;
    try {
        real_source = fs.realpathSync(source);
    } catch (_unresolvable) {
        logger().warn(
            `Skipping unresolvable path (broken symlink?): ${relative_path} `
            + `(source ${entry.host_path}).`
        );
        return;
    }

    if (!is_path_within(real_source, real_root)) {
        logger().warn(
            `Skipping path whose real location escapes the source tree: ${relative_path} `
            + `(source ${entry.host_path}). Symlinks — or symlinked parent directories — `
            + `pointing outside the project are not copied into the sandbox workspace.`
        );
        return;
    }

    if (!fs.statSync(real_source).isFile()) {
        if (options?.allow_submodules) {
            stage_submodule(
                entry.host_path, relative_path, all_sources, options,
                staging_directory, real_root,
            );
        }
        return;
    }

    const destination = path.join(staging_directory, relative_path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

export function copy_multi_source_files(
    name: string,
    sources: Source_Specification[],
    options: Resolve_Files_Options | undefined,
    working_directory: string = CONTAINER_WORKING_DIR,
): void {
    prepare_workspace(name, working_directory);

    for (const [index, entry] of sources.entries()) {
        logger().info(`${entry.host_path} ${index + 1}/${sources.length}`);
        const files = resolve_files(entry.host_path, options);
        if (files.length === 0) {
            continue;
        }
        const real_root = fs.realpathSync(entry.host_path);
        const staging_directory = fs.mkdtempSync(path.join(runtime_host_tmpdir(), 'patchlab-staging-'));
        try {
            for (const relative_path of files) {
                stage_one_source_file(entry, relative_path, sources, options, staging_directory, real_root);
            }
            const container_target = entry.mount_name === ''
                ? working_directory
                : `${working_directory}/${entry.mount_name}`;
            exec_container(name, ['mkdir', '-p', container_target]);
            copy_to_container(name, staging_directory + '/.', container_target);
            fix_workspace_ownership_if_needed(name, container_target);
        } finally {
            fs.rmSync(staging_directory, { recursive: true, force: true });
        }
    }
}

/** Detect and install npm dependencies, committing them to the git baseline. */
export function install_dependencies(name: string, working_directory: string = CONTAINER_WORKING_DIR): void {
    try {
        const ls_output = exec_container(name, ['ls', working_directory], { cwd: working_directory });
        const listed_files = new Set(ls_output.split('\n').map((line) => line.trim()).filter(Boolean));
        const has_lockfile = listed_files.has('package-lock.json');
        const has_package_json = listed_files.has('package.json');

        if (has_lockfile) {
            exec_container(name, ['npm', 'ci'], { cwd: working_directory });
            exec_container(name, ['git', 'add', '-A'], { cwd: working_directory });
            exec_container(name, ['git', 'commit', '-m', 'dependencies', '--allow-empty'], { cwd: working_directory });
        } else if (has_package_json) {
            exec_container(name, ['npm', 'install'], { cwd: working_directory });
            exec_container(name, ['git', 'add', '-A'], { cwd: working_directory });
            exec_container(name, ['git', 'commit', '-m', 'dependencies', '--allow-empty'], { cwd: working_directory });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: npm install failed — ${message}. You can install dependencies manually inside the container.`);
    }
}

/** Install globally-required npm packages and run optional init commands. */
export function install_npm_packages(name: string, packages: Npm_Package_Requirement[], working_directory: string = CONTAINER_WORKING_DIR): void {
    for (const package_requirement of packages) {
        try {
            logger().info(`Installing tool: ${package_requirement.package}`);
            exec_container(name, ['npm', 'install', '-g', package_requirement.package], { cwd: working_directory });
            if (package_requirement.init_command) {
                exec_container(name, package_requirement.init_command, { cwd: working_directory });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(`Warning: failed to install ${package_requirement.package} — ${message}. You can install it manually.`);
        }
    }

    try {
        exec_container(name, ['git', 'add', '-A'], { cwd: working_directory });
        exec_container(name, ['git', 'commit', '-m', 'tools', '--allow-empty'], { cwd: working_directory });
    } catch (_git_checkpoint_failed) {
        // git checkpoint after dependency install is non-essential
        // — sandbox works without it
    }
}

/**
 * Build a host-overlay staging directory for a multi-source patchlab.
 *
 * For each source, files matching the include/exclude globs that are NOT
 * tracked on the patchlab branch are copied into the staging directory under
 * the source's mount path (= `source_prefix` under this change's invariant).
 * Files at branch-tip paths are skipped — the caller's branch-tip export
 * step is the authoritative source for those.
 *
 * `branch_files` is the union of repository-relative paths across every source's
 * mount, produced by `list_branch_files(repository_root, patchlab_id,
 * source_prefixes)`. The per-source key written into the staging directory
 * is the source-relative path; the key checked against `branch_files` is the
 * repository-relative path (prefix + relative).
 *
 * File modes and symlinks are preserved where the host filesystem supports them.
 */
export function overlay_multi_source_host_files(
    sources: Source_Specification[],
    staging_directory: string,
    include_globs: string[] | undefined,
    exclude_globs: string[] | undefined,
    branch_files: Set<string>,
): void {
    for (const entry of sources) {
        overlay_source_files_into_staging(entry, staging_directory, include_globs, exclude_globs, branch_files);
    }
}

/**
 * Iterate one source's include/exclude-matched files and stage each into
 * `staging_directory`. Files at branch-tip paths are skipped — the caller's
 * branch-tip export step is the authoritative source for those.
 */
function overlay_source_files_into_staging(
    entry: Source_Specification,
    staging_directory: string,
    include_globs: string[] | undefined,
    exclude_globs: string[] | undefined,
    branch_files: Set<string>,
): void {
    if (!fs.existsSync(entry.host_path)) {
        return;
    }

    const source_files = resolve_files(entry.host_path, {
        include: include_globs,
        exclude: exclude_globs,
    });
    for (const relative_path of source_files) {
        stage_one_overlay_file(entry, relative_path, staging_directory, branch_files);
    }
}

/**
 * Stage a single source-relative file into the overlay staging directory.
 * The key checked against `branch_files` is mount-name-relative (matching
 * the container's workspace layout); the staging-directory path is also
 * mount-name-relative so the overlay step lands files at the correct
 * `${HOME}/workspace/<mount_name>/...` location.
 */
function stage_one_overlay_file(
    entry: Source_Specification,
    relative_path: string,
    staging_directory: string,
    branch_files: Set<string>,
): void {
    const normalized = relative_path.replaceAll('\\', '/');
    const mount_relative = entry.mount_name === ''
        ? normalized
        : `${entry.mount_name}/${normalized}`;
    if (branch_files.has(mount_relative)) {
        return;
    }
    const stage_relative = entry.mount_name === ''
        ? relative_path
        : path.join(entry.mount_name, relative_path);
    const destination = path.join(staging_directory, stage_relative);
    if (fs.existsSync(destination)) {
        return;
    }
    const source = path.join(entry.host_path, relative_path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
        stage_overlay_symlink(source, destination, entry.host_path, relative_path);
        return;
    }
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
}

/**
 * Stage a single symlink, skipping any whose target escapes the source root
 * (such links can leak container-internal files like `/proc/self/environ`
 * to the AI tool inside the sandbox).
 */
function stage_overlay_symlink(
    source: string,
    destination: string,
    host_path: string,
    relative_path: string,
): void {
    stage_symlink_within_root(source, destination, host_path, relative_path);
}

export function prepare_workspace(container_name: string, working_directory: string): void {
    // Single `sh -c` with the path passed as a POSITIONAL ARGUMENT ($1), not
    // interpolated into the script text. This keeps it injection-safe — for a
    // configured provider `working_directory` derives from the manifest's
    // `image_home` (user-editable YAML), and a value like `/home/x; cmd` or
    // `/opt/my tool` would otherwise inject shell or split into the wrong
    // `rm -rf` target — while staying a SINGLE exec. Two separate execs do not
    // work here: `podman exec` chdir's into the container WORKDIR (= this very
    // directory) before each command, so a second exec after `rm -rf` fails to
    // chdir into the directory it just deleted. One shell chdir's once (the dir
    // still exists), removes it, then recreates it by absolute path.
    //
    // Run as root: socket-mounted sandboxes use `--userns=keep-id`, so a
    // non-root exec inherits the image user and cannot recreate a workspace
    // directory owned by root or another uid (common on stock base images).
    exec_container(container_name, [
        'sh', '-c', 'rm -rf "$1" && mkdir -p "$1"', 'sh', working_directory,
    ], { user: 'root' });
    fix_workspace_ownership_if_needed(container_name, working_directory);
}

export function overlay_into_container(
    container_name: string,
    staging_directory: string,
    working_directory: string
): void {
    if (fs.readdirSync(staging_directory).length === 0) {
        return;
    }

    fix_workspace_ownership_if_needed(container_name, working_directory);
    copy_to_container(container_name, staging_directory + '/.', working_directory);
    fix_workspace_ownership_if_needed(container_name, working_directory);
}

/**
 * Returns true when `source_path` matches one of `DEFAULT_SECRET_EXCLUDES`.
 * For directories, also tests a synthetic child path so patterns like
 * `**\/.ssh\/**` match the directory itself (the glob requires a trailing segment).
 */
function source_matches_secret_pattern(source_path: string, is_directory: boolean): boolean {
    const normalized = source_path.replaceAll('\\', '/');
    const paths_to_test = is_directory ? [normalized, normalized + '/x'] : [normalized];
    return DEFAULT_SECRET_EXCLUDES.some(
        (pattern) => paths_to_test.some((check) => picomatch.isMatch(check, pattern)),
    );
}

/**
 * Follows a symlink and returns true when its target matches a secret-file
 * pattern (file) or contains a secret (directory). Returns false for broken,
 * circular, or unreadable targets (ELOOP, ENOENT, EACCES, etc.).
 */
function check_symlink_for_secret(entry_path: string, visited: Set<string>): boolean {
    try {
        return fs.statSync(entry_path).isDirectory()
            ? directory_contains_secret(entry_path, visited)
            : source_matches_secret_pattern(entry_path, false);
    } catch {
        return false;
    }
}

/**
 * Returns true when a single directory entry — real file, real subdirectory,
 * or symlink — matches or contains a secret-file pattern.
 */
function check_directory_entry_for_secret(
    entry: fs.Dirent,
    entry_path: string,
    visited: Set<string>,
): boolean {
    if (entry.isDirectory()) {
        return directory_contains_secret(entry_path, visited);
    }

    return entry.isSymbolicLink()
        ? check_symlink_for_secret(entry_path, visited)
        : source_matches_secret_pattern(entry_path, false);
}

/**
 * Returns true when `directory_path` or any file recursively inside it
 * matches `DEFAULT_SECRET_EXCLUDES`. Catches cases like `--copy ~/.aws`
 * where the directory itself does not match but `credentials` inside does.
 *
 * Symlinks to directories are followed via `check_symlink_for_secret` so a
 * symlink pointing at a directory containing secrets is detected. A `visited`
 * set of real paths (from `fs.realpathSync`) breaks cycles so a symlink
 * pointing back to an ancestor directory does not loop forever. Errors on any
 * individual entry (broken link, ELOOP, permission denied) are silently
 * skipped — those entries are unreadable by the copy step too.
 */
function directory_contains_secret(directory_path: string, visited: Set<string>): boolean {
    let real_path: string;
    try {
        real_path = fs.realpathSync(directory_path);
    } catch {
        return false;
    }

    if (visited.has(real_path)) {
        return false;
    }

    visited.add(real_path);

    if (source_matches_secret_pattern(directory_path, true)) {
        return true;
    }

    try {
        for (const entry of fs.readdirSync(directory_path, { withFileTypes: true })) {
            const entry_path = path.join(directory_path, entry.name);
            if (check_directory_entry_for_secret(entry, entry_path, visited)) {
                return true;
            }
        }
    } catch {
        // Unreadable directory — skip, copy_additional_paths will surface the error.
    }

    return false;
}

/**
 * Returns true when any `--copy` source matches `DEFAULT_SECRET_EXCLUDES`.
 * For directory sources, checks recursively (following symlinks to directories,
 * with cycle detection) so that copying `~/.aws` (which contains `credentials`)
 * is caught even though the directory path itself does not match
 * `**\/.aws\/credentials`. Sources that do not exist are skipped (they will be
 * warned about in `copy_additional_paths`). Called by create and resume before
 * container creation so the prompter can gate and the image tier can apply the
 * auth tag.
 */
export function detect_secret_copies(copy_paths: Copy_Specification[]): string[] {
    return copy_paths
        .filter((specification) => {
            if (!fs.existsSync(specification.source_path)) {
                return false;
            }

            return fs.lstatSync(specification.source_path).isDirectory()
                ? directory_contains_secret(specification.source_path, new Set())
                : source_matches_secret_pattern(specification.source_path, false);
        })
        .map((specification) => specification.source_path);
}

/**
 * Copy each `--copy` specification into the container workspace. Sources that
 * do not exist on the host are skipped with a warning. Symlinks within copied
 * directories are contained to the source root (escape attempts are skipped
 * with a warning), mirroring the rules applied to source files.
 *
 * Called after `copy_multi_source_files` and before `initialize_sandbox_git_baseline`
 * so copies are physically present during the baseline init. Whether they appear
 * in the baseline commit depends on `.gitignore` in the workspace.
 */
export function copy_additional_paths(
    container_name: string,
    copy_paths: Copy_Specification[],
    working_directory: string = CONTAINER_WORKING_DIR,
): void {
    if (copy_paths.length === 0) {
        return;
    }

    for (const specification of copy_paths) {
        if (!fs.existsSync(specification.source_path)) {
            logger().warn(
                `Warning: --copy source does not exist; skipping: ${specification.source_path}`
            );
            continue;
        }

        const staging_directory = fs.mkdtempSync(path.join(runtime_host_tmpdir(), 'patchlab-copy-one-'));
        try {
            const staging_destination = path.join(staging_directory, specification.destination);
            fs.mkdirSync(path.dirname(staging_destination), { recursive: true });

            const containing_root = fs.lstatSync(specification.source_path).isDirectory()
                ? specification.source_path
                : path.dirname(specification.source_path);

            copy_path_recursively(specification.source_path, staging_destination, containing_root);

            const host_source = fs.lstatSync(staging_destination).isDirectory()
                ? `${staging_destination}/.`
                : staging_destination;
            copy_into_workspace(container_name, host_source, working_directory, specification.destination);
        } finally {
            fs.rmSync(staging_directory, { recursive: true, force: true });
        }
    }
}

export function initialize_sandbox_git_baseline(container_name: string, working_directory: string): void {
    fix_workspace_ownership_if_needed(container_name, working_directory);
    const exec_options = { cwd: working_directory };
    exec_container(container_name, ['git', 'init'], exec_options);
    exec_container(container_name, ['git', 'config', 'core.autocrlf', 'false'], exec_options);
    exec_container(container_name, ['git', 'config', 'core.eol', 'lf'], exec_options);
    exec_container(container_name, ['git', 'config', 'user.email', 'patchlab@local'], exec_options);
    exec_container(container_name, ['git', 'config', 'user.name', 'patchlab'], exec_options);
    exec_container(container_name, ['git', 'add', '-A'], exec_options);
    exec_container(container_name, ['git', 'commit', '-m', 'baseline', '--allow-empty'], exec_options);
}

/**
 * Scan each source's composer.json for a `name` field, then cross-reference
 * other sources' `require`/`require-dev` blocks. For every cross-source match,
 * run `composer config --global` inside the container so the local copy is
 * used instead of the packagist version when `composer install` runs.
 *
 * Reads composer.json from the host (sources are mounted at this point) and
 * writes to the container's global composer configuration so the project's own
 * composer.json is not modified.
 */
export function configure_composer_path_repositories(
    container_name: string,
    sources: Source_Specification[],
    working_directory: string = CONTAINER_WORKING_DIR,
): void {
    // First pass: collect declared package names and their container paths.
    const local_packages = new Map<string, string>();
    for (const source of sources) {
        const composer_json_path = path.join(source.host_path, 'composer.json');
        if (!fs.existsSync(composer_json_path)) {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = parse_file_as_json(composer_json_path);
        } catch {
            continue;
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }

        const package_name = (parsed as Record<string, unknown>)['name'];
        if (typeof package_name !== 'string' || !package_name) {
            continue;
        }

        const container_path = source.mount_name === ''
            ? working_directory
            : `${working_directory}/${source.mount_name}`;
        local_packages.set(package_name, container_path);
    }

    if (local_packages.size === 0) {
        return;
    }

    // Second pass: find sources that require any locally-sourced package.
    const path_repositories = new Map<string, string>();
    for (const source of sources) {
        const composer_json_path = path.join(source.host_path, 'composer.json');
        if (!fs.existsSync(composer_json_path)) {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = parse_file_as_json(composer_json_path);
        } catch {
            continue;
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }

        const raw = parsed as Record<string, unknown>;
        for (const section of ['require', 'require-dev']) {
            const require_block = raw[section];
            if (require_block === null || typeof require_block !== 'object' || Array.isArray(require_block)) {
                continue;
            }

            for (const required_package of Object.keys(require_block as Record<string, unknown>)) {
                const container_path = local_packages.get(required_package);
                if (container_path !== undefined) {
                    path_repositories.set(required_package, container_path);
                }
            }
        }
    }

    if (path_repositories.size === 0) {
        return;
    }

    for (const [package_name, container_path] of path_repositories) {
        const repository_config = JSON.stringify({ type: 'path', url: container_path });
        try {
            exec_container(container_name, [
                'composer', 'config', '--global',
                `repositories.${package_name}`, repository_config, '--json',
            ], { cwd: working_directory });
            logger().info(`Configured composer path repository: ${package_name} → ${container_path}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(
                `Warning: failed to configure composer path repository for ${package_name} — ${message}.`
            );
        }
    }
}
