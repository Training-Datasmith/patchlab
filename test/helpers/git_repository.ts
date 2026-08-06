// Shared helpers for tests that build a real on-disk git repository as a
// fixture. Centralizes the test identity, the silent-git wrapper, and the
// canonical "init + README + initial commit" sequence so callers don't each
// re-implement the four-line incantation with their own GIT_ENV constant.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Git identity for test commits. Spreading `process.env` first lets the rest
 * of the environment (PATH, locale, credentials helpers, etc.) flow through
 * to the `git` subprocess; the four `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * overrides ensure commits don't accidentally depend on the developer's
 * `.gitconfig` identity.
 */
export const GIT_TEST_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
};

/**
 * Run a `git` subcommand with stdio piped (no output to the parent's
 * terminal) and the canonical test identity. Use for fixture-building calls
 * where stdout/stderr would be noise; tests that NEED to inspect git's
 * output should call `execFileSync` directly with their own stdio config.
 */
export function run_git_silently(directory: string, args: string[]): void {
    execFileSync('git', args, {
        cwd: directory,
        env: GIT_TEST_ENVIRONMENT,
        stdio: 'pipe',
    });
}

/**
 * Resolve a git reference (branch name, tag, `HEAD`, or any rev-parse-able
 * expression) to its SHA-1 string. Trims the trailing newline so callers
 * get a pure SHA back.
 */
export function resolve_revision(directory: string, reference: string): string {
    return execFileSync('git', ['rev-parse', reference], {
        cwd: directory,
        env: GIT_TEST_ENVIRONMENT,
        encoding: 'utf-8',
    }).trim();
}

/**
 * Read the current default branch (HEAD's symbolic ref). Useful in tests
 * whose assertions need to survive a future host whose `init.defaultBranch`
 * is `main` vs `master`.
 */
export function read_default_branch(directory: string): string {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: directory,
        env: GIT_TEST_ENVIRONMENT,
        encoding: 'utf-8',
    }).trim();
}

/**
 * Build a fresh git repository with a single README-only initial commit.
 * The default `readme_contents` and `commit_message` cover the common case;
 * pass overrides for tests that need a specific initial content (e.g. patch-
 * generation tests asserting on the resulting diff).
 */
export function initialize_repository_with_initial_commit(
    directory: string,
    options?: {
        readme_contents?: string;
        commit_message?: string;
    },
): void {
    const readme_contents = options?.readme_contents ?? 'initial\n';
    const commit_message = options?.commit_message ?? 'initial';
    run_git_silently(directory, ['init']);
    fs.writeFileSync(path.join(directory, 'README.md'), readme_contents);
    run_git_silently(directory, ['add', '-A']);
    run_git_silently(directory, ['commit', '-m', commit_message]);
}
