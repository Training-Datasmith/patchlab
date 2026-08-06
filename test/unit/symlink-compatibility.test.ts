import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Re-export `node:fs` as a plain namespace so its properties are configurable —
// the SUT does `import * as fs from 'node:fs'` and certain entries (e.g.
// `readlinkSync`, `readdirSync`) are non-configurable on Node 22, which makes
// `vi.spyOn` throw `Cannot redefine property`. Spreading via importActual into
// a fresh object preserves runtime behavior while allowing per-test mocking.
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...actual };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    copy_symlink_with_dereference_fallback,
    find_escape_symlinks,
    is_symlink_target_within_root,
    stage_symlink_within_root,
} from '../../src/symlink_compatibility.js';

function make_filesystem_error(code: 'EPERM' | 'ENOTSUP' | 'EACCES'): NodeJS.ErrnoException {
    const error = new Error(`mock ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('is_symlink_target_within_root (M2 — overlay symlink validation)', () => {
    let source_root: string;

    beforeEach(() => {
        source_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symlink-')));
    });

    afterEach(() => {
        fs.rmSync(source_root, { recursive: true, force: true });
    });

    function make_symlink(name: string, target: string): string {
        const link_path = path.join(source_root, name);
        try {
            fs.symlinkSync(target, link_path);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'ENOTSUP') {
                // Windows without admin/dev mode — skip the assertion suite cleanly.
                throw new Error('SKIP: symlinks not supported in this environment');
            }
            throw error;
        }
        return link_path;
    }

    it('rejects an absolute target like /proc/self/environ', () => {
        let link: string;
        try {
            link = make_symlink('bad-absolute', '/proc/self/environ');
        } catch (e) {
            if ((e as Error).message.startsWith('SKIP')) {
                return;
            }
            throw e;
        }
        expect(is_symlink_target_within_root(link, source_root)).toBe(false);
    });

    it('rejects an absolute target like /etc/passwd', () => {
        let link: string;
        try {
            link = make_symlink('bad-passwd', '/etc/passwd');
        } catch (e) {
            if ((e as Error).message.startsWith('SKIP')) {
                return;
            }
            throw e;
        }
        expect(is_symlink_target_within_root(link, source_root)).toBe(false);
    });

    it('rejects a relative target that escapes via ..', () => {
        let link: string;
        try {
            link = make_symlink('bad-escape', '../../etc/passwd');
        } catch (e) {
            if ((e as Error).message.startsWith('SKIP')) {
                return;
            }
            throw e;
        }
        expect(is_symlink_target_within_root(link, source_root)).toBe(false);
    });

    it('accepts a relative target that stays inside the source root', () => {
        fs.writeFileSync(path.join(source_root, 'real.txt'), 'content');
        let link: string;
        try {
            link = make_symlink('good', './real.txt');
        } catch (e) {
            if ((e as Error).message.startsWith('SKIP')) {
                return;
            }
            throw e;
        }
        expect(is_symlink_target_within_root(link, source_root)).toBe(true);
    });

    it('accepts a relative target with .. that stays inside via cancellation', () => {
        fs.mkdirSync(path.join(source_root, 'subdir'));
        fs.writeFileSync(path.join(source_root, 'real.txt'), 'content');
        let link: string;
        try {
            link = make_symlink(path.join('subdir', 'sibling'), '../real.txt');
        } catch (e) {
            if ((e as Error).message.startsWith('SKIP')) {
                return;
            }
            throw e;
        }
        expect(is_symlink_target_within_root(link, source_root)).toBe(true);
    });
});

describe('copy_symlink_with_dereference_fallback', () => {
    let source_root: string;
    let destination_root: string;

    beforeEach(() => {
        source_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symcopy-src-')));
        destination_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symcopy-dst-')));
    });

    afterEach(() => {
        fs.rmSync(source_root, { recursive: true, force: true });
        fs.rmSync(destination_root, { recursive: true, force: true });
    });

    it('records broken symlinks as a placeholder file rather than aborting', () => {
        const link_path = path.join(source_root, 'broken');
        try {
            fs.symlinkSync('./does-not-exist', link_path);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'ENOTSUP') {
                return;
            }
            throw error;
        }
        const destination = path.join(destination_root, 'broken');

        // First try the symlink path; if it succeeds, we won't exercise the fallback.
        // Force the fallback by creating a destination that's already a regular file
        // so symlink creation fails with EEXIST? Actually that's a different error.
        // Easier: just call it and check the destination ends up as either a symlink
        // or a placeholder file with the broken-link marker.
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        const dest_stat = fs.lstatSync(destination);
        if (dest_stat.isSymbolicLink()) {
            // Symlink path worked; nothing more to assert.
            return;
        }
        // Fallback placeholder.
        const content = fs.readFileSync(destination, 'utf-8');
        expect(content).toContain('Broken symlink');
    });
});

describe('copy_symlink_with_dereference_fallback (forced dereference fallback)', () => {
    let source_root: string;
    let destination_root: string;

    beforeEach(() => {
        source_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symcopy-fb-')));
        destination_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symcopy-fb-dst-')));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(source_root, { recursive: true, force: true });
        fs.rmSync(destination_root, { recursive: true, force: true });
    });

    /**
     * Fake a source-side "symlink" by writing the target text into a regular
     * file and shimming `fs.readlinkSync` to return that text. The
     * `copy_symlink_with_dereference_fallback` flow only reads the symlink's
     * target string via `readlinkSync`; nothing else needs a real link, so
     * we can drive the fallback path on any host filesystem.
     */
    function seed_pseudo_symlink(name: string, target: string): string {
        const source_path = path.join(source_root, name);
        fs.writeFileSync(source_path, target);
        return source_path;
    }

    it('falls back to dereferenced copy when symlinkSync throws EPERM', () => {
        fs.writeFileSync(path.join(source_root, 'real.txt'), 'real content');
        const link_path = seed_pseudo_symlink('link.txt', './real.txt');
        vi.spyOn(fs, 'readlinkSync').mockReturnValue('./real.txt');
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });

        const destination = path.join(destination_root, 'link.txt');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        expect(fs.readFileSync(destination, 'utf-8')).toBe('real content');
    });

    it('falls back to dereferenced copy when symlinkSync throws ENOTSUP', () => {
        fs.writeFileSync(path.join(source_root, 'real.txt'), 'real');
        const link_path = seed_pseudo_symlink('link.txt', './real.txt');
        vi.spyOn(fs, 'readlinkSync').mockReturnValue('./real.txt');
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('ENOTSUP');
        });

        const destination = path.join(destination_root, 'link.txt');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        expect(fs.readFileSync(destination, 'utf-8')).toBe('real');
    });

    it('writes a broken-symlink placeholder when the target does not exist', () => {
        const link_path = seed_pseudo_symlink('link.txt', './does-not-exist.txt');
        vi.spyOn(fs, 'readlinkSync').mockReturnValue('./does-not-exist.txt');
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });

        const destination = path.join(destination_root, 'link.txt');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        const content = fs.readFileSync(destination, 'utf-8');
        expect(content).toContain('Broken symlink');
        expect(content).toContain('./does-not-exist.txt');
    });

    it('recursively copies an in-root directory target on the fallback path', () => {
        const target_directory = path.join(source_root, 'target-dir');
        fs.mkdirSync(target_directory);
        fs.writeFileSync(path.join(target_directory, 'top.txt'), 'top');
        fs.mkdirSync(path.join(target_directory, 'nested'));
        fs.writeFileSync(path.join(target_directory, 'nested', 'inner.txt'), 'inner');
        const link_path = seed_pseudo_symlink('link', './target-dir');
        vi.spyOn(fs, 'readlinkSync').mockReturnValue('./target-dir');
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });

        const destination = path.join(destination_root, 'link');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        expect(fs.readFileSync(path.join(destination, 'top.txt'), 'utf-8')).toBe('top');
        expect(fs.readFileSync(
            path.join(destination, 'nested', 'inner.txt'),
            'utf-8',
        )).toBe('inner');
    });

    it('honors an absolute target path in the fallback (no relative resolution)', () => {
        const absolute_target = path.join(source_root, 'absolute-target.txt');
        fs.writeFileSync(absolute_target, 'absolute content');
        const link_path = seed_pseudo_symlink('link.txt', absolute_target);
        vi.spyOn(fs, 'readlinkSync').mockReturnValue(absolute_target);
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });

        const destination = path.join(destination_root, 'link.txt');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        expect(fs.readFileSync(destination, 'utf-8')).toBe('absolute content');
    });

    it('preserves file mode on the dereferenced copy', () => {
        if (process.platform === 'win32') {
            // chmod is a no-op on Windows; assertion is platform-specific.
            return;
        }
        const real_path = path.join(source_root, 'real.sh');
        fs.writeFileSync(real_path, '#!/bin/sh\necho hi\n');
        fs.chmodSync(real_path, 0o750);
        const link_path = seed_pseudo_symlink('link.sh', './real.sh');
        vi.spyOn(fs, 'readlinkSync').mockReturnValue('./real.sh');
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });

        const destination = path.join(destination_root, 'link.sh');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        expect(fs.statSync(destination).mode & 0o777).toBe(0o750);
    });

    it('rethrows non-EPERM/ENOTSUP errors from symlinkSync without falling back', () => {
        const link_path = seed_pseudo_symlink('link.txt', './target.txt');
        vi.spyOn(fs, 'readlinkSync').mockReturnValue('./target.txt');
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EACCES');
        });

        const destination = path.join(destination_root, 'link.txt');
        expect(() => copy_symlink_with_dereference_fallback(link_path, destination, source_root))
            .toThrow(/EACCES/);
    });

    it('refuses to materialize an out-of-root dereferenced target (no host bytes copied)', () => {
        // The realpath leg, not the lexical gate, is what catches this: the link's
        // dereferenced target sits OUTSIDE `source_root` (here, under the sibling
        // destination_root). The fallback must skip it with a placeholder rather
        // than copying the host file's bytes into the sandbox.
        const outside_secret = path.join(destination_root, 'secret.txt');
        fs.writeFileSync(outside_secret, 'TOP-SECRET-HOST-CONTENT');
        const link_path = seed_pseudo_symlink('link.txt', outside_secret);
        vi.spyOn(fs, 'readlinkSync').mockReturnValue(outside_secret);
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });

        const destination = path.join(destination_root, 'copied-link.txt');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        const content = fs.readFileSync(destination, 'utf-8');
        expect(content).not.toContain('TOP-SECRET-HOST-CONTENT');
        expect(content).toContain('Skipped symlink (target outside permitted root)');
    });

    it('dereferences an absolute in-root target instead of replicating it (never replicates a host-absolute link)', () => {
        const absolute_target = path.join(source_root, 'abs-in-root.txt');
        fs.writeFileSync(absolute_target, 'abs in-root content');
        const link_path = seed_pseudo_symlink('link.txt', absolute_target);
        vi.spyOn(fs, 'readlinkSync').mockReturnValue(absolute_target);
        // symlinkSync is spied but NOT forced to throw: a host-absolute path
        // means nothing inside the container, so the copier must dereference its
        // content rather than replicate the link. If it wrongly tried to
        // replicate, this spy would record the call.
        const symlink_spy = vi.spyOn(fs, 'symlinkSync');

        const destination = path.join(destination_root, 'link.txt');
        copy_symlink_with_dereference_fallback(link_path, destination, source_root);

        expect(symlink_spy).not.toHaveBeenCalled();
        expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(destination, 'utf-8')).toBe('abs in-root content');
    });
});

describe('stage_symlink_within_root (shared overlay/context gate)', () => {
    let source_root: string;
    let destination_root: string;

    beforeEach(() => {
        source_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-stage-src-')));
        destination_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-stage-dst-')));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(source_root, { recursive: true, force: true });
        fs.rmSync(destination_root, { recursive: true, force: true });
    });

    function try_make_symlink(name: string, target: string): string | null {
        const link_path = path.join(source_root, name);
        try {
            fs.symlinkSync(target, link_path);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'ENOTSUP') {
                return null;
            }
            throw error;
        }
        return link_path;
    }

    it('refuses an escaping link: returns false and writes nothing at the destination', () => {
        const link_path = try_make_symlink('escape', '/etc/passwd');
        if (link_path === null) {
            return;
        }
        const destination = path.join(destination_root, 'escape');

        const staged = stage_symlink_within_root(link_path, destination, source_root, 'escape');

        expect(staged).toBe(false);
        expect(fs.existsSync(destination)).toBe(false);
    });

    it('stages an in-root link: returns true and dereferences the in-root target', () => {
        fs.writeFileSync(path.join(source_root, 'real.txt'), 'in-root content');
        const link_path = try_make_symlink('good', './real.txt');
        if (link_path === null) {
            return;
        }

        // Force the dereference fallback so the assertion is deterministic across
        // platforms: a replicated relative link would dangle in the destination
        // directory (which has no `real.txt`), whereas the fallback copies the
        // in-root target's bytes.
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw make_filesystem_error('EPERM');
        });
        const destination = path.join(destination_root, 'good');

        const staged = stage_symlink_within_root(link_path, destination, source_root, 'good');

        expect(staged).toBe(true);
        expect(fs.readFileSync(destination, 'utf-8')).toBe('in-root content');
    });
});

describe('find_escape_symlinks (M3 — archive injection validation)', () => {
    let archive_root: string;

    beforeEach(() => {
        archive_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-arch-')));
    });

    afterEach(() => {
        fs.rmSync(archive_root, { recursive: true, force: true });
    });

    function try_make_symlink(name: string, target: string): boolean {
        try {
            const dest_dir = path.dirname(path.join(archive_root, name));
            fs.mkdirSync(dest_dir, { recursive: true });
            fs.symlinkSync(target, path.join(archive_root, name));
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return !(code === 'EPERM' || code === 'ENOTSUP');
        }
    }

    it('returns empty when the archive has no symlinks', () => {
        fs.writeFileSync(path.join(archive_root, 'a.json'), '{}');
        fs.mkdirSync(path.join(archive_root, 'sub'));
        fs.writeFileSync(path.join(archive_root, 'sub', 'b.json'), '{}');

        expect(find_escape_symlinks(archive_root)).toEqual([]);
    });

    it('flags symlinks with absolute targets', () => {
        if (!try_make_symlink('peek', '/proc/self/environ')) {
            return;
        }
        const findings = find_escape_symlinks(archive_root);
        expect(findings).toContain('peek');
    });

    it('flags symlinks that escape via .. relative paths', () => {
        if (!try_make_symlink('escape', '../../etc/passwd')) {
            return;
        }
        const findings = find_escape_symlinks(archive_root);
        expect(findings).toContain('escape');
    });

    it('does not flag symlinks that stay within the archive root', () => {
        fs.writeFileSync(path.join(archive_root, 'real.json'), '{}');
        if (!try_make_symlink('alias', './real.json')) {
            return;
        }
        const findings = find_escape_symlinks(archive_root);
        expect(findings).not.toContain('alias');
    });

    it('walks subdirectories', () => {
        if (!try_make_symlink('sub/inside-sub', '/etc/hostname')) {
            return;
        }
        const findings = find_escape_symlinks(archive_root);
        expect(findings).toContain('sub/inside-sub');
    });

    it('rethrows EACCES so the caller aborts rather than scanning an incomplete tree', () => {
        vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
            throw make_filesystem_error('EACCES');
        });

        // EACCES means the directory exists but is unreadable — escape symlinks
        // inside it are invisible. Rethrowing forces the caller to abort
        // injection rather than proceed with incomplete security information.
        expect(() => find_escape_symlinks(archive_root)).toThrow();
        vi.restoreAllMocks();
    });
});
