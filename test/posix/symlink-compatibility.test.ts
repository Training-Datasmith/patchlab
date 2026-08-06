// POSIX-only assertions for the real-symlink paths of src/symlink_compatibility.ts.
// Run via the `posix` vitest project (npm run test:posix) inside a Linux
// container. The unit tier covers the dereference fallback cross-platform via
// pseudo-symlinks + fs spies; these need GENUINE symlinks (find_escape_symlinks
// detects link-ness through readdir's Dirent, which a pseudo-symlink cannot fake,
// and the stage gate is exercised end-to-end through a real link here).
//
// Locks the two option-2 properties whose safety hinges on the host-vs-container
// distinction:
//   1. stage_symlink_within_root DEREFERENCES an in-root absolute target to host
//      content (cluster 1 dropped all absolute targets; option 2 copies in-root
//      absolute content because no host-absolute link ever reaches the container)
//      and still REFUSES an out-of-root absolute target.
//   2. find_escape_symlinks STILL refuses an absolute target even when it
//      resolves inside the archive root — those links travel verbatim into the
//      container via `podman cp`, where a host-absolute path resolves against the
//      container filesystem, so host containment cannot make them safe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    find_escape_symlinks,
    stage_symlink_within_root,
} from '../../src/symlink_compatibility.js';

describe('stage_symlink_within_root — absolute targets (POSIX-only)', () => {
    let source_root: string;
    let destination_root: string;

    beforeEach(() => {
        source_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-stage-abs-src-')));
        destination_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-stage-abs-dst-')));
    });

    afterEach(() => {
        fs.rmSync(source_root, { recursive: true, force: true });
        fs.rmSync(destination_root, { recursive: true, force: true });
    });

    it('stages an in-root link with an ABSOLUTE target by dereferencing its content', () => {
        fs.writeFileSync(path.join(source_root, 'real.txt'), 'absolute in-root body');
        const link_path = path.join(source_root, 'abs-good');
        // Absolute target that resolves inside the root.
        fs.symlinkSync(path.join(source_root, 'real.txt'), link_path);
        const destination = path.join(destination_root, 'abs-good');

        const staged = stage_symlink_within_root(link_path, destination, source_root, 'abs-good');

        expect(staged).toBe(true);
        // Dereferenced to content — not a replicated host-absolute link.
        expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(destination, 'utf-8')).toBe('absolute in-root body');
    });

    it('refuses an absolute target that resolves OUTSIDE the root (nothing staged)', () => {
        const outside_secret = path.join(destination_root, 'secret.txt');
        fs.writeFileSync(outside_secret, 'TOP-SECRET');
        const link_path = path.join(source_root, 'abs-bad');
        fs.symlinkSync(outside_secret, link_path);
        const destination = path.join(destination_root, 'abs-bad');

        const staged = stage_symlink_within_root(link_path, destination, source_root, 'abs-bad');

        expect(staged).toBe(false);
        expect(fs.existsSync(destination)).toBe(false);
    });
});

describe('find_escape_symlinks — absolute targets stay refused (POSIX-only security guard)', () => {
    let archive_root: string;

    beforeEach(() => {
        archive_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-arch-abs-')));
    });

    afterEach(() => {
        fs.rmSync(archive_root, { recursive: true, force: true });
    });

    it('flags an ABSOLUTE target even when it resolves inside the archive root', () => {
        // Unlike the staging path (which dereferences an in-root absolute target
        // to host content), find_escape_symlinks guards links that `podman cp`
        // extracts VERBATIM into the container, where a host-absolute path
        // resolves against the CONTAINER filesystem. Host containment proves
        // nothing there, so EVERY absolute target — in-root or not — must be
        // refused. Relaxing this to match the staging gate would be a
        // sandbox-escape regression.
        fs.writeFileSync(path.join(archive_root, 'real.json'), '{}');
        fs.symlinkSync(path.join(archive_root, 'real.json'), path.join(archive_root, 'abs-in-root'));

        expect(find_escape_symlinks(archive_root)).toContain('abs-in-root');
    });
});
