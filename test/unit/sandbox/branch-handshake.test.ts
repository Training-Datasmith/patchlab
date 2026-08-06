import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    collect_unique_repositories,
    execute_phase_1_preflight,
    validate_source_paths,
} from '../../../src/sandbox/branch_handshake.js';
import type { Source_Specification } from '../../../src/manifest.js';
import { initialize_repository_with_initial_commit, run_git_silently } from '../../helpers/git_repository.js';
import { make_fake_prompter } from '../../helpers/fake_prompter.js';

function make_source(overrides: Partial<Source_Specification> = {}): Source_Specification {
    return {
        host_path: '/host/repo-a/src',
        repository_root: '/host/repo-a',
        source_prefix: 'src',
        mount_name: 'repo-a',
        ...overrides,
    };
}

describe('validate_source_paths', () => {
    let temporary: string;
    let directory_path: string;
    let file_path: string;

    beforeEach(() => {
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-validate-sources-'));
        directory_path = path.join(temporary, 'sub-directory');
        fs.mkdirSync(directory_path);
        file_path = path.join(temporary, 'plain-file.txt');
        fs.writeFileSync(file_path, '');
    });

    afterEach(() => {
        fs.rmSync(temporary, { recursive: true, force: true });
    });

    it('throws when sources is empty', () => {
        expect(() => validate_source_paths([])).toThrow(/non-empty/);
    });

    it('accepts a directory entry', () => {
        expect(() =>
            validate_source_paths([make_source({ host_path: directory_path })]),
        ).not.toThrow();
    });

    it('throws when host_path does not exist', () => {
        const missing = path.join(temporary, 'does-not-exist');
        expect(() =>
            validate_source_paths([make_source({ host_path: missing })]),
        ).toThrow(new RegExp(`Source directory not found.*${missing.replaceAll('\\', '\\\\')}`));
    });

    it('throws when host_path resolves to a file rather than a directory', () => {
        expect(() =>
            validate_source_paths([make_source({ host_path: file_path })]),
        ).toThrow(/not a directory/);
    });

    it('validates each entry — fails fast on the first invalid one', () => {
        const missing = path.join(temporary, 'gone');
        expect(() => validate_source_paths([
            make_source({ host_path: directory_path }),
            make_source({ host_path: missing }),
        ])).toThrow(/Source directory not found/);
    });
});

describe('collect_unique_repositories', () => {
    it('returns each distinct repository_root in first-appearance order', () => {
        const result = collect_unique_repositories([
            make_source({ repository_root: '/host/a' }),
            make_source({ repository_root: '/host/b' }),
            make_source({ repository_root: '/host/c' }),
        ]);
        expect(result).toEqual(['/host/a', '/host/b', '/host/c']);
    });

    it('deduplicates by byte-for-byte string equality, keeping the first occurrence', () => {
        const result = collect_unique_repositories([
            make_source({ repository_root: '/host/a' }),
            make_source({ repository_root: '/host/b' }),
            make_source({ repository_root: '/host/a' }),
            make_source({ repository_root: '/host/b' }),
        ]);
        expect(result).toEqual(['/host/a', '/host/b']);
    });

    it('distinguishes paths that differ only by case (no normalization)', () => {
        const result = collect_unique_repositories([
            make_source({ repository_root: '/Host/A' }),
            make_source({ repository_root: '/host/a' }),
        ]);
        expect(result).toEqual(['/Host/A', '/host/a']);
    });

    it('returns [] when sources is empty', () => {
        expect(collect_unique_repositories([])).toEqual([]);
    });
});

// Phase 1 preflight runs three guard checks per repository before any host
// mutation: (a) is-git-repository, (b) submodule detection, (c) dirty-tree
// detection. Each guard throws on violation and short-circuits the iteration
// (subsequent repositories are NOT evaluated, even if they're clean). These
// tests cover the throw paths — the happy path is exercised by the integration
// suite via create_sandbox.
describe('execute_phase_1_preflight — guard throws', () => {
    let temporary: string;

    beforeEach(() => {
        temporary = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-preflight-')),
        );
    });

    afterEach(() => {
        fs.rmSync(temporary, { recursive: true, force: true });
    });

    it('throws when a repository is not a git repository (sub-step a)', async () => {
        // Bare directory — no `.git/` — exercises assert_repository_is_git.
        // The error names the non-git path so the operator can pin which
        // source resolved to a tampered or moved location.
        await expect(
            execute_phase_1_preflight([temporary], 'pl-not-git', undefined),
        ).rejects.toThrow(new RegExp(
            `Repository ${temporary.replaceAll('\\', '\\\\')} is not a git repository`,
        ));
    });

    it('throws when a repository contains submodules and allow_submodules is omitted (sub-step b)', async () => {
        // A `.gitmodules` file is detect_submodules' sole signal — git's own
        // tracking is not consulted. Adding the file with one `path =` entry
        // is enough to trip the guard.
        initialize_repository_with_initial_commit(temporary);
        fs.writeFileSync(path.join(temporary, '.gitmodules'), [
            '[submodule "vendor/lib"]',
            '\tpath = vendor/lib',
            '\turl = https://example.com/lib.git',
        ].join('\n'));

        await expect(
            execute_phase_1_preflight([temporary], 'pl-has-submodules', undefined),
        ).rejects.toThrow(/contains git submodules: vendor\/lib/);
    });

    it('passes through when submodules are present and allow_submodules is true (sub-step b opt-in)', async () => {
        // Confirms the `!allow_submodules` half of the guard's condition —
        // a regression that flipped the polarity would surface as the throw
        // firing despite the explicit opt-in. The .gitmodules file is
        // committed so the downstream dirty-tree guard doesn't intercept.
        initialize_repository_with_initial_commit(temporary);
        fs.writeFileSync(path.join(temporary, '.gitmodules'), [
            '[submodule "vendor/lib"]',
            '\tpath = vendor/lib',
        ].join('\n'));
        run_git_silently(temporary, ['add', '.gitmodules']);
        run_git_silently(temporary, ['commit', '-m', 'add submodule entry']);

        await expect(
            execute_phase_1_preflight([temporary], 'pl-allow-submodules', { allow_submodules: true }),
        ).resolves.toBeInstanceOf(Set);
    });

    it('throws when the working tree is dirty and allow_dirty_tree is omitted (sub-step c, undefined branch)', async () => {
        // allow_dirty_tree: undefined produces the "guidance" throw that
        // points the operator at the allow_dirty_tree: true opt-in. This
        // message also surfaces when a null prompter encounters a dirty tree
        // (no interactive path available to confirm).
        initialize_repository_with_initial_commit(temporary);
        fs.writeFileSync(path.join(temporary, 'dirty.txt'), 'untracked\n');

        await expect(
            execute_phase_1_preflight([temporary], 'pl-dirty-undefined', undefined),
        ).rejects.toThrow(/has uncommitted changes.*Pass allow_dirty_tree: true to proceed/s);
    });

    it('throws with the "aborting per false" message when allow_dirty_tree is explicitly false (sub-step c, false branch)', async () => {
        // allow_dirty_tree: false is the post-confirmation hard rejection —
        // the user has already been prompted and declined, so the message is
        // the terminal one (no retry guidance).
        initialize_repository_with_initial_commit(temporary);
        fs.writeFileSync(path.join(temporary, 'dirty.txt'), 'untracked\n');

        await expect(
            execute_phase_1_preflight([temporary], 'pl-dirty-false', { allow_dirty_tree: false }),
        ).rejects.toThrow(/has uncommitted changes.*Aborting per allow_dirty_tree: false/s);
    });

    it('records the repository as dirty (instead of throwing) when allow_dirty_tree is true', async () => {
        // The true branch is what Phase 2 reads to know which repositories
        // need a baseline commit. The returned Set drives that downstream
        // decision; an empty Set when the tree is dirty would silently skip
        // the baseline write.
        initialize_repository_with_initial_commit(temporary);
        fs.writeFileSync(path.join(temporary, 'dirty.txt'), 'untracked\n');

        const result = await execute_phase_1_preflight(
            [temporary], 'pl-dirty-true', { allow_dirty_tree: true },
        );
        expect(result).toEqual(new Set([temporary]));
    });

    it('short-circuits on the first failing repository (does not evaluate later ones)', async () => {
        // The guard checks run in repository order; a failure on repo #1 must
        // skip every subsequent repo. We verify by pointing the second slot
        // at a non-git path that would ALSO throw if reached — and asserting
        // that the error names the FIRST repo, proving the second was never
        // evaluated.
        initialize_repository_with_initial_commit(temporary);
        fs.writeFileSync(path.join(temporary, '.gitmodules'), [
            '[submodule "vendor/lib"]',
            '\tpath = vendor/lib',
        ].join('\n'));
        const non_git_second = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-preflight-skip-')),
        );
        try {
            await expect(execute_phase_1_preflight(
                [temporary, non_git_second], 'pl-fail-fast', undefined,
            )).rejects.toThrow(/contains git submodules/);
            // If the second slot HAD been evaluated, the thrown message
            // would name `non_git_second` with "is not a git repository"
            // instead.
        } finally {
            fs.rmSync(non_git_second, { recursive: true, force: true });
        }
    });
});

describe('execute_phase_1_preflight — prompter-based dirty-tree confirmation', () => {
    let repository_a: string;
    let repository_b: string;

    beforeEach(() => {
        repository_a = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-preflight-prompt-a-')),
        );
        repository_b = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-preflight-prompt-b-')),
        );
        initialize_repository_with_initial_commit(repository_a);
        initialize_repository_with_initial_commit(repository_b);
    });

    afterEach(() => {
        fs.rmSync(repository_a, { recursive: true, force: true });
        fs.rmSync(repository_b, { recursive: true, force: true });
    });

    it('records the repo as dirty and resolves (does not throw) when prompter confirms', async () => {
        fs.writeFileSync(path.join(repository_a, 'dirty.txt'), 'untracked\n');
        const fake = make_fake_prompter({ confirm: [true] });
        const result = await execute_phase_1_preflight(
            [repository_a], 'pl-prompt-confirms', { prompter: fake },
        );
        expect(result).toEqual(new Set([repository_a]));
    });

    it('fires the dirty-tree prompt exactly once across two dirty repos (once per condition, not per repo)', async () => {
        // Design Decision 6: one confirmation covers all repositories in the
        // call. The queue has exactly one answer — if the prompt fired a second
        // time, Fake_Prompter would throw Prompter_Exhausted and the test
        // would fail with a clear "over-prompted" message.
        fs.writeFileSync(path.join(repository_a, 'dirty.txt'), 'untracked\n');
        fs.writeFileSync(path.join(repository_b, 'dirty.txt'), 'untracked\n');
        const fake = make_fake_prompter({ confirm: [true] });
        const result = await execute_phase_1_preflight(
            [repository_a, repository_b], 'pl-prompt-once', { prompter: fake },
        );
        expect(result).toEqual(new Set([repository_a, repository_b]));
    });

    it('throws when prompter declines the dirty-tree confirmation', async () => {
        fs.writeFileSync(path.join(repository_a, 'dirty.txt'), 'untracked\n');
        const fake = make_fake_prompter({ confirm: [false] });
        await expect(
            execute_phase_1_preflight([repository_a], 'pl-prompt-declines', { prompter: fake }),
        ).rejects.toThrow(/has uncommitted changes/);
    });
});
