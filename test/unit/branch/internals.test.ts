import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    list_other_local_branches,
    rev_parse,
    run_git,
} from '../../../src/branch/internals.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    resolve_revision,
    run_git_silently,
} from '../../helpers/git_repository.js';

describe('run_git', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-run-git-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns stdout, empty stderr, and status 0 on success', () => {
        const result = run_git(['rev-parse', 'HEAD'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    });

    it('throws on non-zero exit when allow_failure is not set', () => {
        expect(() => run_git(['rev-parse', 'no-such-ref'], { cwd: repository, env: GIT_TEST_ENVIRONMENT }))
            .toThrow();
    });

    it('returns exit info instead of throwing when allow_failure is set', () => {
        const result = run_git(['rev-parse', 'no-such-ref'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            allow_failure: true,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('writes stdin input to the subprocess (string)', () => {
        // `git hash-object --stdin` reads from stdin and writes the SHA to stdout.
        const result = run_git(['hash-object', '--stdin'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            input: 'hello',
        });
        // `git hash-object` of "hello" deterministically produces this SHA.
        expect(result.stdout.trim()).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
    });

    it('writes stdin input to the subprocess (Buffer)', () => {
        const buffer = Buffer.from([0x68, 0x69]); // "hi"
        const result = run_git(['hash-object', '--stdin'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            input: buffer,
        });
        expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    });
});

describe('rev_parse', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-rev-parse-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns the HEAD SHA without trailing whitespace', () => {
        const sha = rev_parse(repository, 'HEAD');
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        expect(sha).toBe(sha.trim());
    });

    it('matches `git rev-parse` invoked directly', () => {
        const actual = resolve_revision(repository, 'HEAD');
        expect(rev_parse(repository, 'HEAD')).toBe(actual);
    });

    it('resolves named refs (default branch)', () => {
        // initialize_repository_with_initial_commit leaves one branch checked out.
        // Resolve by reading HEAD's symbolic-ref target.
        const head_branch = run_git(['symbolic-ref', '--short', 'HEAD'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
        }).stdout.trim();
        expect(rev_parse(repository, head_branch)).toBe(rev_parse(repository, 'HEAD'));
    });

    it('throws when the ref does not exist', () => {
        expect(() => rev_parse(repository, 'no-such-branch')).toThrow();
    });
});

describe('list_other_local_branches', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-list-other-branches-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns [] in a single-branch repository when excluding that branch', () => {
        const head_branch = run_git(['symbolic-ref', '--short', 'HEAD'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
        }).stdout.trim();
        expect(list_other_local_branches(repository, head_branch)).toEqual([]);
    });

    it('lists every local branch except the excluded one', () => {
        run_git_silently(repository, ['branch', 'feature-a']);
        run_git_silently(repository, ['branch', 'feature-b']);
        const branches = list_other_local_branches(repository, 'feature-a');
        expect(branches).not.toContain('feature-a');
        expect(branches).toContain('feature-b');
    });

    it('lists all branches when the exclude name does not match any existing branch', () => {
        run_git_silently(repository, ['branch', 'feature-a']);
        const branches = list_other_local_branches(repository, 'not-a-real-branch');
        expect(branches).toContain('feature-a');
    });
});
