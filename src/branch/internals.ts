/**
 * Internal helpers shared across the branch subsystem.
 *
 * `run_git` is the synchronous git wrapper every sibling file uses to talk to
 * git from the host. `rev_parse` is the SHA-reading thin wrapper. And
 * `list_other_local_branches` is shared by both the unapplied-commits
 * cherry-pick comparison (delete.ts) and the find-branch-creation-point
 * fallback (diff_read.ts), so it lives here as a cross-cluster utility rather
 * than in either consumer.
 */
import { execFileSync } from 'node:child_process';

export interface Git_Run_Options {
    cwd: string;
    /**
     * Stdin to write to git. Pass a Buffer when the content may include non-UTF-8 bytes
     * (e.g., binary diffs) — strings are written as UTF-8, which would corrupt binary content
     * and re-encode any bytes ≥ 0x80 in a "binary"/latin1 string into multi-byte UTF-8.
     */
    input?: string | Buffer;
    env?: NodeJS.ProcessEnv;
    /** When true, don't throw on non-zero exit; return exit info instead. */
    allow_failure?: boolean;
}

export interface Git_Result {
    stdout: string;
    stderr: string;
    status: number;
}

export interface Git_Buffer_Result {
    stdout: Buffer;
    stderr: string;
    status: number;
}

/**
 * Like `run_git`, but captures stdout as a raw `Buffer` (no UTF-8 decode). Use
 * for commands whose output may contain non-UTF-8 bytes — notably
 * `git diff --binary`, where a UTF-8 decode replaces the high bytes of
 * text-classified files in latin1/other encodings with U+FFFD and silently
 * corrupts the patch. Pair with a `Buffer` `input` (and a file written from the
 * `Buffer`) so bytes never round-trip through a string.
 */
export function run_git_capture_buffer(git_arguments: string[], options: Git_Run_Options): Git_Buffer_Result {
    try {
        const stdout = execFileSync('git', git_arguments, {
            cwd: options.cwd,
            input: options.input,
            env: options.env,
            stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
            maxBuffer: 256 * 1024 * 1024,
            // No `encoding` → execFileSync returns a Buffer.
        });
        return { stdout, stderr: '', status: 0 };
    } catch (error: unknown) {
        if (options.allow_failure) {
            const error_information = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
            return {
                stdout: error_information.stdout ?? Buffer.alloc(0),
                stderr: error_information.stderr?.toString() ?? '',
                status: error_information.status ?? 1,
            };
        }

        throw error;
    }
}

/** Synchronous git wrapper that throws on failure unless `allow_failure` is set. */
export function run_git(git_arguments: string[], options: Git_Run_Options): Git_Result {
    try {
        const stdout = execFileSync('git', git_arguments, {
            cwd: options.cwd,
            input: options.input,
            env: options.env,
            stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            maxBuffer: 256 * 1024 * 1024,
        });
        return { stdout, stderr: '', status: 0 };
    } catch (error: unknown) {
        if (options.allow_failure) {
            const error_information = error as { stdout?: string; stderr?: string; status?: number };
            return {
                stdout: error_information.stdout?.toString() ?? '',
                stderr: error_information.stderr?.toString() ?? '',
                status: error_information.status ?? 1,
            };
        }

        throw error;
    }
}

/** Read the SHA of HEAD or any other ref. */
export function rev_parse(repository_root: string, ref: string): string {
    return run_git(['rev-parse', ref], { cwd: repository_root }).stdout.trim();
}

/**
 * List every local branch EXCEPT `exclude`. Used by `unapplied_session_commits`
 * (delete.ts) for the per-other-branch `git cherry` comparison, and by
 * `find_branch_creation_point` (diff_read.ts) for the legacy merge-base
 * fallback.
 */
export function list_other_local_branches(repository_root: string, exclude: string): string[] {
    const result = run_git(
        ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
        { cwd: repository_root }
    );
    const all = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    return all.filter((branch) => branch !== exclude);
}
