// POSIX-only assertions for branch.ts host-side exports. Run via the `posix`
// vitest project (see vitest.config.ts) — typically inside a Linux container
// with `npm run test:posix`. `export_branch_tip` shells out to the host `tar`,
// which on Windows hosts (GNU tar via Git Bash) mis-parses `tar -xf C:\...`
// as a remote-host fetch and fails. The function's docstring also notes that
// executable bits are lost on hosts without POSIX mode tracking — so host-side
// export is a POSIX-only operation by design; container-bound exports use
// `export_per_source_branch_tip_to_container` instead.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { create_patchlab_branch, export_branch_tip } from '../../src/branch/index.js';

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
};

function init_repository(directory: string): void {
    execFileSync('git', ['init'], { cwd: directory });
    fs.writeFileSync(path.join(directory, 'README.md'), '# test\n');
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: directory, env: GIT_ENV });
}

function commit_all(directory: string, message: string): void {
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['commit', '-m', message], { cwd: directory, env: GIT_ENV });
}

describe('export_branch_tip', () => {
    let repository: string;
    let home_root: string;
    let original_home: string | undefined;
    let original_userprofile: string | undefined;
    let destination_directory: string;

    const PATCHLAB_ID = 'pl-export';

    beforeEach(() => {
        home_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-export-home-'));
        original_home = process.env.HOME;
        original_userprofile = process.env.USERPROFILE;
        process.env.HOME = home_root;
        process.env.USERPROFILE = home_root;

        repository = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-export-')),
        );
        init_repository(repository);
        // Stage two extra files at HEAD before the patchlab branch is created so
        // the branch tip contains a non-trivial tree to archive.
        fs.writeFileSync(path.join(repository, 'foo.txt'), 'foo body\n');
        fs.writeFileSync(path.join(repository, 'bar.txt'), 'bar body\n');
        commit_all(repository, 'add foo and bar');
        create_patchlab_branch(repository, PATCHLAB_ID);

        destination_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-export-dest-')),
        );
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = original_home;
        }
        if (original_userprofile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = original_userprofile;
        }
        fs.rmSync(repository, { recursive: true, force: true });
        fs.rmSync(destination_directory, { recursive: true, force: true });
        fs.rmSync(home_root, { recursive: true, force: true });
    });

    it('extracts the branch tip into the destination directory', async () => {
        await export_branch_tip(repository, PATCHLAB_ID, destination_directory);
        const entries = fs.readdirSync(destination_directory);
        expect(entries).toContain('foo.txt');
        expect(entries).toContain('bar.txt');
        expect(entries).toContain('README.md');
        expect(fs.readFileSync(path.join(destination_directory, 'foo.txt'), 'utf-8'))
            .toBe('foo body\n');
    });

    it('throws when the destination directory does not exist', async () => {
        const missing = path.join(destination_directory, 'does-not-exist');
        await expect(export_branch_tip(repository, PATCHLAB_ID, missing))
            .rejects.toThrow(/does not exist/);
    });

    it('throws non-interactively when the archive exceeds max_size_bytes', async () => {
        await expect(export_branch_tip(repository, PATCHLAB_ID, destination_directory, [''], {
            max_size_bytes: 1,
        })).rejects.toThrow(/Branch archive is/);
    });

    it('proceeds when confirm_oversized returns true', async () => {
        const confirm_oversized = (): boolean => true;
        await export_branch_tip(repository, PATCHLAB_ID, destination_directory, [''], {
            max_size_bytes: 1,
            confirm_oversized,
        });
        expect(fs.readdirSync(destination_directory)).toContain('foo.txt');
    });

    it('aborts with a clear message when confirm_oversized returns false', async () => {
        const confirm_oversized = (): boolean => false;
        await expect(export_branch_tip(repository, PATCHLAB_ID, destination_directory, [''], {
            max_size_bytes: 1,
            confirm_oversized,
        })).rejects.toThrow(/aborted at user request/);
    });
});

describe('export_branch_tip — prefix filtering (POSIX-only since tar -xf is involved)', () => {
    // Separate describe block since these tests need different fixture
    // structure (subdirectories rather than the foo/bar siblings used above).
    let repository: string;
    let home_root: string;
    let original_home: string | undefined;
    let original_userprofile: string | undefined;
    let destination_directory: string;

    beforeEach(() => {
        home_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prefix-home-'));
        original_home = process.env.HOME;
        original_userprofile = process.env.USERPROFILE;
        process.env.HOME = home_root;
        process.env.USERPROFILE = home_root;
        repository = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prefix-')),
        );
        init_repository(repository);
        destination_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prefix-dest-')),
        );
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = original_home;
        }
        if (original_userprofile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = original_userprofile;
        }
        fs.rmSync(repository, { recursive: true, force: true });
        fs.rmSync(destination_directory, { recursive: true, force: true });
        fs.rmSync(home_root, { recursive: true, force: true });
    });

    it('exports only files under a single requested prefix', async () => {
        fs.mkdirSync(path.join(repository, 'subdir'));
        fs.writeFileSync(path.join(repository, 'subdir', 'nested.ts'), 'nested\n');
        commit_all(repository, 'add subdir');
        create_patchlab_branch(repository, 'pl-prefix-single');

        await export_branch_tip(repository, 'pl-prefix-single', destination_directory, ['subdir']);

        expect(fs.readFileSync(path.join(destination_directory, 'subdir', 'nested.ts'), 'utf-8'))
            .toBe('nested\n');
        // README at root is NOT under `subdir/` → not in the archive.
        expect(fs.existsSync(path.join(destination_directory, 'README.md'))).toBe(false);
    });

    it('produces an empty extraction when EVERY supplied non-empty prefix matches no files', async () => {
        // README only at root; neither requested prefix has any matches.
        // `probe_branch_archive` filters them all out → writes canonical
        // 1024-byte empty tar → `tar -xf` is a no-op.
        create_patchlab_branch(repository, 'pl-prefix-all-empty');

        await export_branch_tip(
            repository,
            'pl-prefix-all-empty',
            destination_directory,
            ['ghost', 'phantom'],
        );

        expect(fs.readdirSync(destination_directory)).toEqual([]);
    });

    it('drops the non-matching prefixes and keeps the matching one in a mixed list', async () => {
        fs.mkdirSync(path.join(repository, 'real'));
        fs.writeFileSync(path.join(repository, 'real', 'file.ts'), 'real\n');
        commit_all(repository, 'add real');
        create_patchlab_branch(repository, 'pl-prefix-mixed');

        // `ghost` has no matches; `real` does. The probe must drop the
        // former (or git archive would exit 128) and archive only `real/`.
        await export_branch_tip(
            repository,
            'pl-prefix-mixed',
            destination_directory,
            ['ghost', 'real'],
        );

        expect(fs.readFileSync(path.join(destination_directory, 'real', 'file.ts'), 'utf-8'))
            .toBe('real\n');
    });
});
