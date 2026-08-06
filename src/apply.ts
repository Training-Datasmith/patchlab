import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { safe_unlink } from './safe_filesystem.js';

export interface Patch_File_Result {
    file_path: string;
    success: boolean;
    error?: string;
}

export interface Apply_Result {
    applied: Patch_File_Result[];
    failed: Patch_File_Result[];
    success: boolean;
}

export interface Apply_Options {
    dry_run?: boolean;
}

/**
 * Split a multi-file unified diff into per-file sub-patches. Each block starts
 * with a `diff --git ` line. Lines that precede the first `diff --git ` are
 * dropped (typically commentary or `mbox`-style headers that aren't part of
 * any file's diff).
 */
function split_patch_by_file(patch_content: string): string[] {
    const blocks: string[] = [];
    let current: string[] | null = null;
    for (const line of patch_content.split('\n')) {
        if (line.startsWith('diff --git ')) {
            if (current !== null) {
                blocks.push(current.join('\n'));
            }
            current = [line];
        } else if (current !== null) {
            current.push(line);
        }
    }
    if (current !== null) {
        blocks.push(current.join('\n'));
    }
    return blocks;
}

/**
 * Extract the repository-relative file path a diff block touches. Handles
 * modifications, additions (`--- /dev/null`), deletions (`+++ /dev/null`),
 * and renames (where source and destination paths differ — the destination
 * is reported). Falls back to the `diff --git a/X b/Y` header when the
 * `---` / `+++` lines are absent (e.g. binary patches with no hunk preamble).
 */
function file_path_from_diff_block(block: string): string {
    let minus_a: string | null = null;
    let plus_b: string | null = null;
    let minus_dev_null = false;
    let plus_dev_null = false;
    for (const line of block.split('\n')) {
        if (line === '--- /dev/null') {
            minus_dev_null = true;
        } else if (line === '+++ /dev/null') {
            plus_dev_null = true;
        } else if (line.startsWith('--- a/')) {
            minus_a = line.slice('--- a/'.length);
        } else if (line.startsWith('+++ b/')) {
            plus_b = line.slice('+++ b/'.length);
        }
    }

    if (plus_dev_null && minus_a !== null) {
        return minus_a;
    }

    if (plus_b !== null) {
        return plus_b;
    }
    if (minus_a !== null) {
        return minus_a;
    }

    const header_match = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(block);
    return header_match ? header_match[2] : '(unknown)';
}

function run_git_apply(
    target_directory: string,
    patch_path: string,
    options?: Apply_Options
): Apply_Result {
    const resolved = path.resolve(target_directory);
    const patch_content = fs.readFileSync(patch_path, 'utf-8');
    const blocks = split_patch_by_file(patch_content);

    if (blocks.length === 0) {
        return {
            applied: [],
            failed: [{
                file_path: '(unknown)',
                success: false,
                error: 'No diff blocks found in patch',
            }],
            success: false,
        };
    }

    const applied: Patch_File_Result[] = [];
    const failed: Patch_File_Result[] = [];

    // Apply each file's diff block as its own `git apply` invocation so the
    // success/failure outcome of one file is independent of others. This
    // delivers the honest-partial-reporting contract documented on
    // `apply_patch`: `result.applied` names the files actually written to
    // disk, `result.failed` names the files left at their pre-apply state.
    for (const block of blocks) {
        const file_path = file_path_from_diff_block(block);
        const sub_patch = block.endsWith('\n') ? block : block + '\n';
        const sub_path = path.join(
            os.tmpdir(),
            `patchlab-apply-block-${crypto.randomUUID().slice(0, 8)}.patch`,
        );
        try {
            fs.writeFileSync(sub_path, sub_patch, 'utf-8');
            const args = ['apply'];
            if (options?.dry_run) {
                args.push('--check');
            }
            args.push(sub_path);
            execFileSync('git', args, { cwd: resolved, stdio: 'pipe' });
            applied.push({ file_path, success: true });
        } catch (error) {
            const stderr = error instanceof Error && 'stderr' in error
                ? (error.stderr as Buffer).toString('utf-8')
                : '';
            failed.push({
                file_path,
                success: false,
                error: stderr.trim() || 'Patch does not apply cleanly — file may have diverged',
            });
        } finally {
            safe_unlink(sub_path);
        }
    }

    return { applied, failed, success: failed.length === 0 };
}

/**
 * Apply a unified diff patch to a target directory.
 *
 * Per-file semantics (honest partial reporting): when the patch touches
 * multiple files, each file's diff block is applied independently. A failure
 * on file A does NOT roll back file B. `result.applied` names the files whose
 * disk content was updated; `result.failed` names the files left at their
 * pre-apply state. Within a single file, `git apply`'s usual all-or-nothing
 * rule still holds — either every hunk in that file's block applies or none
 * does. Use `dry_run: true` to check whether the patch WOULD apply without
 * modifying disk.
 */
export function apply_patch(
    target_directory: string,
    patch_content: string,
    options?: Apply_Options
): Apply_Result {
    const temp_path = path.join(
        os.tmpdir(),
        `patchlab-apply-${crypto.randomUUID().slice(0, 8)}.patch`
    );
    try {
        fs.writeFileSync(temp_path, patch_content, 'utf-8');
        return run_git_apply(target_directory, temp_path, options);
    } finally {
        safe_unlink(temp_path);
    }
}

/** Apply a patch from a file path to a target directory. See `apply_patch` for per-file semantics. */
export function apply_patch_file(
    target_directory: string,
    patch_file_path: string,
    options?: Apply_Options
): Apply_Result {
    const resolved_patch = path.resolve(patch_file_path);
    return run_git_apply(target_directory, resolved_patch, options);
}