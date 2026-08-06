// Host-side error branches of `export_branch_tip` and its helpers in
// `src/branch_archive.ts`. The four error paths covered here all fire BEFORE
// `tar -xf` runs, so they are platform-portable (Windows `git archive` writes
// the tar to a host path via stdio piping, which works fine — only the
// `tar -xf` extraction has the GNU-tar / `C:\…` path mis-parse, and that's
// covered in `test/posix/branch.test.ts` for the happy path).
//
// What's covered here:
//   1. `export_branch_tip` rejects a missing destination directory before any
//      git or tar work runs.
//   2. `probe_branch_archive` (via `export_branch_tip`) throws when the
//      requested patchlab branch does not exist in the repository.
//   3. `gate_archive_size` throws non-interactively when the archive exceeds
//      `max_size_bytes` and no `confirm_oversized` is supplied.
//   4. `gate_archive_size` throws "aborted at user request" when
//      `confirm_oversized` returns false.

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_patchlab_branch } from '../../../src/branch/index.js';
import {
    export_branch_tip,
    export_per_source_branch_tip_to_container,
    is_empty_subtree_archive_error,
} from '../../../src/branch/archive.js';
import { initialize_repository_with_initial_commit } from '../../helpers/git_repository.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

describe('export_branch_tip — host-side error branches', () => {
    install_isolated_home_hooks('patchlab-branch-archive-home-');
    // Each test creates a uniquely-named patchlab branch (or no branch at all),
    // so a single `beforeAll` repository serves all four tests. Cuts 12 git
    // spawns (4 × init+add+commit) to 3 for the file.
    let repository: string;

    beforeAll(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-archive-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('rejects a missing destination directory before any git or tar work', async () => {
        // The destination existence check fires at the top of
        // `export_branch_tip`, BEFORE `probe_branch_archive` shells to git.
        // A regression that reordered the check after the probe would cost
        // a wasted `git archive` invocation per bad call.
        create_patchlab_branch(repository, 'pl-missing-dest');
        await expect(
            export_branch_tip(repository, 'pl-missing-dest', '/path/that/definitely/does/not/exist'),
        ).rejects.toThrow(/Destination directory does not exist/);
    });

    it('throws when the patchlab branch does not exist in the repository', async () => {
        // `probe_branch_archive`'s pre-flight catches a typo (or a deleted
        // branch) before invoking `git archive`. The thrown error names the
        // expected branch reference and the repository so the operator can
        // resolve the mismatch.
        const destination = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-archive-dest-')));
        try {
            // No `create_patchlab_branch` call → `patchlab/pl-absent` does not exist.
            await expect(
                export_branch_tip(repository, 'pl-absent', destination),
            ).rejects.toThrow(/patchlab\/pl-absent does not exist/);
        } finally {
            fs.rmSync(destination, { recursive: true, force: true });
        }
    });

    it('throws non-interactively when the archive exceeds max_size_bytes and no confirm callback is supplied', async () => {
        // `gate_archive_size` rejects oversized archives when no
        // `confirm_oversized` callback is supplied — the non-interactive
        // path needs an explicit opt-in to transfer large trees. We force
        // the gate by setting `max_size_bytes: 1` (any non-empty archive
        // will exceed 1 byte). The thrown message names BOTH the actual
        // size and the cap so the operator can decide whether to re-run
        // with a higher cap.
        create_patchlab_branch(repository, 'pl-oversize');
        const destination = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-archive-dest-')));
        try {
            await expect(
                export_branch_tip(repository, 'pl-oversize', destination, [''], { max_size_bytes: 1 }),
            ).rejects.toThrow(/Branch archive is \d+ bytes \(cap: 1\)/);
        } finally {
            fs.rmSync(destination, { recursive: true, force: true });
        }
    });

    it('throws "aborted at user request" when confirm_oversized returns false', async () => {
        // The interactive path: the user declines to proceed when prompted
        // about an oversized transfer. The throw is the load-bearing signal
        // that the user's intent was respected — silently no-op'ing here
        // would let a destructive resume continue against the operator's
        // declared choice.
        create_patchlab_branch(repository, 'pl-aborted');
        const destination = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-archive-dest-')));
        try {
            await expect(
                export_branch_tip(repository, 'pl-aborted', destination, [''], {
                    max_size_bytes: 1,
                    confirm_oversized: () => false,
                }),
            ).rejects.toThrow(/Branch export aborted at user request/);
        } finally {
            fs.rmSync(destination, { recursive: true, force: true });
        }
    });
});

describe('export_per_source_branch_tip_to_container — host-side branches before spawn', () => {
    install_isolated_home_hooks('patchlab-per-source-archive-');
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-per-source-archive-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('throws when the patchlab branch does not exist (before any podman work)', async () => {
        await expect(
            export_per_source_branch_tip_to_container(
                {
                    host_path: repository,
                    repository_root: repository,
                    source_prefix: '',
                    mount_name: '',
                },
                'pl-no-branch',
                'container-x',
                '/workspace',
            ),
        ).rejects.toThrow(/patchlab\/pl-no-branch does not exist/);
    });

    it('trips the size gate after a successful single-source archive (mount_name="")', async () => {
        // source_prefix='' AND mount_name='' takes the bare branch path
        // (line 267 — no --prefix, archive at branch tip). The archive
        // succeeds, then the size gate trips before spawn.
        create_patchlab_branch(repository, 'pl-bare-archive');

        await expect(
            export_per_source_branch_tip_to_container(
                {
                    host_path: repository,
                    repository_root: repository,
                    source_prefix: '',
                    mount_name: '',
                },
                'pl-bare-archive',
                'container-x',
                '/workspace',
                { max_size_bytes: 1 },
            ),
        ).rejects.toThrow(/Branch archive is \d+ bytes \(cap: 1\)/);
    });

    it('trips the size gate after a mount_name-prefixed archive (line 263 --prefix branch)', async () => {
        // mount_name non-empty → `--prefix=<mount_name>/` is added to argv.
        // The archive succeeds, then the size gate trips before spawn.
        create_patchlab_branch(repository, 'pl-mount-name');

        await expect(
            export_per_source_branch_tip_to_container(
                {
                    host_path: repository,
                    repository_root: repository,
                    source_prefix: '',
                    mount_name: 'app',
                },
                'pl-mount-name',
                'container-x',
                '/workspace',
                { max_size_bytes: 1 },
            ),
        ).rejects.toThrow(/Branch archive is \d+ bytes \(cap: 1\)/);
    });
});

describe('is_empty_subtree_archive_error', () => {
    it('matches the "not a tree" prefix', () => {
        expect(is_empty_subtree_archive_error('fatal: not a tree\n')).toBe(true);
    });

    it('matches the "Not a valid object name" prefix', () => {
        expect(is_empty_subtree_archive_error("fatal: Not a valid object name 'foo:bar'\n")).toBe(true);
    });

    it('matches even when the marker appears after preceding stderr noise', () => {
        const stderr = 'some warning\nfatal: not a tree\n';
        expect(is_empty_subtree_archive_error(stderr)).toBe(true);
    });

    it('does NOT match unrelated git errors', () => {
        expect(is_empty_subtree_archive_error('fatal: bad revision\n')).toBe(false);
        expect(is_empty_subtree_archive_error('fatal: permission denied\n')).toBe(false);
        expect(is_empty_subtree_archive_error('error: pathspec did not match\n')).toBe(false);
    });

    it('does NOT match empty stderr', () => {
        expect(is_empty_subtree_archive_error('')).toBe(false);
    });
});
