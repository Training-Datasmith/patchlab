// POSIX-only assertions for `copy_path_recursively` in src/context.ts.
// Run via the `posix` vitest project (see vitest.config.ts) — typically
// inside a Linux container with `npm run test:posix`. Symlink creation
// needs elevation or Developer Mode on Windows; the symlink branches of
// `copy_path_recursively` are therefore POSIX-only.
//
// What's covered here (uncovered by the unit-tier tests for src/context.ts):
//   1. Symlink source, destination does not exist — `fs.unlinkSync` raises
//      ENOENT, the catch swallows it, the dereference-fallback copy runs.
//      This is the happy path through the symlink branch.
//   2. Symlink source, destination already exists as a regular file —
//      `fs.unlinkSync` succeeds, then the dereference-fallback copy runs.
//      Proves the unlink-first sequence runs (a regression that skipped
//      the unlink would surface as ENOTEMPTY/EEXIST from the symlink call).
//   3. Symlink source, destination already exists as a non-empty directory
//      — `fs.unlinkSync` raises EISDIR (Linux) / EPERM (others), the catch
//      sees a code other than ENOENT and re-throws. Validates the precise
//      "surface the error now" path the docstring promises.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build_session_path } from '../../src/archive.js';
import { copy_context_to_archive, resolve_context_paths } from '../../src/context.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

describe('copy_path_recursively — symlink source (POSIX-only via copy_context_to_archive)', () => {
    install_isolated_home_hooks('patchlab-ctx-symlink-home-');

    const PATCHLAB_ID = 'pl-ctx-symlink';
    const SESSION_NUMBER = 1;
    let working_directory: string;

    beforeEach(() => {
        working_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-ctx-symlink-src-')),
        );
    });

    afterEach(() => {
        fs.rmSync(working_directory, { recursive: true, force: true });
    });

    it('copies a symlink source into a fresh destination (ENOENT unlink branch)', () => {
        // Target file the symlink points at.
        const target = path.join(working_directory, 'target.md');
        fs.writeFileSync(target, 'target body');
        // The symlink itself — used as the --context input.
        const link_path = path.join(working_directory, 'link.md');
        fs.symlinkSync(target, link_path);

        const resolved = resolve_context_paths(['./link.md'], working_directory);
        copy_context_to_archive(resolved.entries, PATCHLAB_ID, SESSION_NUMBER);

        // The destination resolves to the target body either way (copy_symlink
        // dereferences when symlinks aren't supported, or follows the link
        // when they are). We only assert reachability — symlinkness of the
        // destination is `copy_symlink_with_dereference_fallback`'s contract,
        // not `copy_path_recursively`'s.
        const destination = build_session_path(PATCHLAB_ID, SESSION_NUMBER, 'context/link.md');
        expect(fs.readFileSync(destination, 'utf-8')).toBe('target body');
    });

    it('replaces an existing regular file at the destination (unlink-succeeds branch)', () => {
        // First pass: a regular file lands at the destination.
        const original = path.join(working_directory, 'note.md');
        fs.writeFileSync(original, 'original body');
        copy_context_to_archive(
            resolve_context_paths(['./note.md'], working_directory).entries,
            PATCHLAB_ID, SESSION_NUMBER,
        );

        // Second pass: replace `./note.md` with a symlink to a different file.
        // The destination from pass 1 must be unlinked before the symlink
        // copy runs. A regression that skipped the unlink would either
        // produce an EEXIST from copy_symlink_with_dereference_fallback or
        // leave the original file in place.
        fs.unlinkSync(original);
        const target = path.join(working_directory, 'replacement.md');
        fs.writeFileSync(target, 'replacement body');
        fs.symlinkSync(target, original);
        copy_context_to_archive(
            resolve_context_paths(['./note.md'], working_directory).entries,
            PATCHLAB_ID, SESSION_NUMBER,
        );

        const destination = build_session_path(PATCHLAB_ID, SESSION_NUMBER, 'context/note.md');
        expect(fs.readFileSync(destination, 'utf-8')).toBe('replacement body');
    });

    it('re-throws when the destination exists as a non-ENOENT-unlinkable directory', () => {
        // First pass: a directory lands at the destination.
        const directory_source = path.join(working_directory, 'docs');
        fs.mkdirSync(directory_source);
        fs.writeFileSync(path.join(directory_source, 'a.md'), 'a body');
        copy_context_to_archive(
            resolve_context_paths(['./docs'], working_directory).entries,
            PATCHLAB_ID, SESSION_NUMBER,
        );

        // Second pass: replace `./docs` with a symlink. The destination from
        // pass 1 is now a non-empty directory. `fs.unlinkSync` raises EISDIR
        // (Linux) / EPERM (BSD) — neither ENOENT — so the catch re-throws.
        // The docstring promises this surface: "any other code (EACCES,
        // EBUSY, EISDIR, EPERM) would block the symlink write that follows,
        // so surface it now with the precise error".
        fs.rmSync(directory_source, { recursive: true, force: true });
        const target = path.join(working_directory, 'target.md');
        fs.writeFileSync(target, 'target body');
        fs.symlinkSync(target, directory_source);

        expect(() => copy_context_to_archive(
            resolve_context_paths(['./docs'], working_directory).entries,
            PATCHLAB_ID, SESSION_NUMBER,
        )).toThrow(/EISDIR|EPERM/);
    });
});
