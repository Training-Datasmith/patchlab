import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    branch_exists,
    detect_submodules,
    is_git_repository,
    is_working_tree_dirty,
    patchlab_branch_exists,
} from '../../../src/branch/predicates.js';
import { patchlab_branch_name } from '../../../src/branch/naming.js';
import {
    initialize_repository_with_initial_commit,
    run_git_silently,
} from '../../helpers/git_repository.js';

describe('is_git_repository', () => {
    let temporary: string;

    beforeEach(() => {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-is-git-repo-'));
    });

    afterEach(() => {
        fs.rmSync(temporary, { recursive: true, force: true });
    });

    it('returns true inside a git working tree', () => {
        initialize_repository_with_initial_commit(temporary);
        expect(is_git_repository(temporary)).toBe(true);
    });

    it('returns false in a non-git directory', () => {
        expect(is_git_repository(temporary)).toBe(false);
    });

    it('returns false when the directory does not exist', () => {
        expect(is_git_repository(path.join(temporary, 'never-created'))).toBe(false);
    });
});

describe('is_working_tree_dirty', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-is-dirty-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns false on a clean working tree', () => {
        expect(is_working_tree_dirty(repository)).toBe(false);
    });

    it('returns true with an untracked file', () => {
        fs.writeFileSync(path.join(repository, 'untracked.txt'), 'new');
        expect(is_working_tree_dirty(repository)).toBe(true);
    });

    it('returns true with a modified tracked file', () => {
        const tracked = path.join(repository, 'README.md');
        fs.writeFileSync(tracked, 'modified content\n');
        expect(is_working_tree_dirty(repository)).toBe(true);
    });

    it('returns false when only gitignored files exist', () => {
        fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored.txt\n');
        run_git_silently(repository, ['add', '.gitignore']);
        run_git_silently(repository, ['commit', '-m', 'add gitignore']);
        fs.writeFileSync(path.join(repository, 'ignored.txt'), 'noise');
        expect(is_working_tree_dirty(repository)).toBe(false);
    });
});

describe('detect_submodules', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-submodules-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns [] when no .gitmodules file exists', () => {
        expect(detect_submodules(repository)).toEqual([]);
    });

    it('returns the list of submodule paths declared in .gitmodules', () => {
        fs.writeFileSync(path.join(repository, '.gitmodules'), [
            '[submodule "vendor/lib-a"]',
            '\tpath = vendor/lib-a',
            '\turl = https://example.invalid/lib-a.git',
            '[submodule "vendor/lib-b"]',
            '\tpath = vendor/lib-b',
            '\turl = https://example.invalid/lib-b.git',
        ].join('\n'));
        expect(detect_submodules(repository)).toEqual(['vendor/lib-a', 'vendor/lib-b']);
    });

    it('returns [] when .gitmodules has no path = entries', () => {
        fs.writeFileSync(path.join(repository, '.gitmodules'), '# comment only\n[submodule "x"]\n');
        expect(detect_submodules(repository)).toEqual([]);
    });
});

describe('branch_exists', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-exists-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns true for an existing branch', () => {
        run_git_silently(repository, ['branch', 'feature-x']);
        expect(branch_exists(repository, 'feature-x')).toBe(true);
    });

    it('returns false for a branch that does not exist', () => {
        expect(branch_exists(repository, 'no-such-branch')).toBe(false);
    });
});

describe('patchlab_branch_exists', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-patchlab-branch-exists-'));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns true when patchlab/{id} exists', () => {
        run_git_silently(repository, ['branch', patchlab_branch_name('abc')]);
        expect(patchlab_branch_exists(repository, 'abc')).toBe(true);
    });

    it('returns false when patchlab/{id} does not exist', () => {
        expect(patchlab_branch_exists(repository, 'never-created')).toBe(false);
    });

    it('returns false when an unrelated branch exists', () => {
        run_git_silently(repository, ['branch', 'feature-x']);
        expect(patchlab_branch_exists(repository, 'feature-x')).toBe(false);
    });
});
