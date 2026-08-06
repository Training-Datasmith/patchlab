import { describe, it, expect } from 'vitest';
import { DEFAULT_SECRET_EXCLUDES } from '../../../src/sandbox/index.js';
import { globSync } from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Scope: this suite characterizes the DEFAULT_SECRET_EXCLUDES pattern LIST in
 * isolation — it passes the patterns to its own `globSync({ ignore })` to pin
 * which name shapes the list does and does not match (`.env.*`, `.envrc`,
 * `.netrc`, the `.ssh/**` directory, `*.pub` left allowed, the `*.key`
 * false-positive trade-off).
 *
 * It deliberately does NOT exercise the production filter chain. The composition
 * that actually keeps secrets out of a sandbox — the `[...DEFAULT_SECRET_EXCLUDES,
 * ...user_ignore]` merge and the `include_secret_files` opt-out inside the private
 * `resolve_files` (src/sandbox/workspace_staging.ts) — is covered against the real
 * `copy_multi_source_files` path in
 * `test/unit/sandbox/workspace-staging.test.ts` ("copy_multi_source_files —
 * secret excludes (production resolve_files path)"). Keep the production guarantee
 * there; this file only guards the constant.
 */
describe('DEFAULT_SECRET_EXCLUDES (L3 — pattern-list characterization; production merge covered in workspace-staging.test.ts)', () => {
    let source_root: string;

    function init_source_tree(): void {
        source_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-secrets-')));

        // Files we expect to be EXCLUDED by default.
        fs.writeFileSync(path.join(source_root, '.env'), 'API_KEY=top-secret');
        fs.writeFileSync(path.join(source_root, '.env.local'), 'LOCAL=value');
        fs.writeFileSync(path.join(source_root, '.envrc'), 'export FOO=bar');
        fs.writeFileSync(path.join(source_root, 'server.pem'), 'PRIVATE');
        fs.writeFileSync(path.join(source_root, 'cert.key'), 'PRIVATE');
        fs.writeFileSync(path.join(source_root, '.netrc'), 'machine x login y');
        fs.mkdirSync(path.join(source_root, '.ssh'));
        fs.writeFileSync(path.join(source_root, '.ssh', 'id_rsa'), 'PRIVATE');
        fs.writeFileSync(path.join(source_root, '.ssh', 'config'), 'Host *');
        fs.mkdirSync(path.join(source_root, 'subproject'));
        fs.writeFileSync(path.join(source_root, 'subproject', '.env'), 'NESTED=secret');

        // Files we expect to be INCLUDED.
        fs.writeFileSync(path.join(source_root, 'README.md'), '# project');
        fs.writeFileSync(path.join(source_root, 'app.ts'), 'const x = 1;');
        fs.writeFileSync(path.join(source_root, 'cool-key.txt'), 'translation key');
        fs.writeFileSync(path.join(source_root, 'public.pub'), 'ssh-rsa AAAA...');
    }

    function cleanup(): void {
        fs.rmSync(source_root, { recursive: true, force: true });
    }

    function resolve_with_defaults(): string[] {
        return globSync(['**/*'], {
            cwd: source_root,
            nodir: true,
            dot: true,
            ignore: DEFAULT_SECRET_EXCLUDES,
        });
    }

    it('excludes top-level .env, .env.* and .envrc', () => {
        init_source_tree();
        try {
            const files = resolve_with_defaults();
            expect(files).not.toContain('.env');
            expect(files).not.toContain('.env.local');
            expect(files).not.toContain('.envrc');
        } finally {
            cleanup();
        }
    });

    it('excludes nested .env files in subdirectories', () => {
        init_source_tree();
        try {
            const files = resolve_with_defaults();
            expect(files.map((f) => f.replaceAll('\\', '/'))).not.toContain('subproject/.env');
        } finally {
            cleanup();
        }
    });

    it('excludes *.pem and *.key files', () => {
        init_source_tree();
        try {
            const files = resolve_with_defaults();
            expect(files).not.toContain('server.pem');
            expect(files).not.toContain('cert.key');
        } finally {
            cleanup();
        }
    });

    it('excludes the entire .ssh directory', () => {
        init_source_tree();
        try {
            const files = resolve_with_defaults().map((f) => f.replaceAll('\\', '/'));
            expect(files).not.toContain('.ssh/id_rsa');
            expect(files).not.toContain('.ssh/config');
        } finally {
            cleanup();
        }
    });

    it('does NOT exclude unrelated files even when names look similar', () => {
        init_source_tree();
        try {
            const files = resolve_with_defaults();
            expect(files).toContain('README.md');
            expect(files).toContain('app.ts');
            // Public SSH keys (.pub) are safe to include.
            expect(files).toContain('public.pub');
        } finally {
            cleanup();
        }
    });

    /**
     * Note: `cool-key.txt` should be allowed, but `*.key` is broad enough to catch
     * `something.key` patterns. The reviewer accepted this trade-off — false positives
     * favor security. This test documents the current behavior (including any
     * over-eager matches) so it's visible.
     */
    it('flags broad patterns that may catch non-secret files (documents trade-off)', () => {
        init_source_tree();
        try {
            const files = resolve_with_defaults();
            // `cool-key.txt` doesn't match *.key (pattern needs the file to end in .key).
            expect(files).toContain('cool-key.txt');
        } finally {
            cleanup();
        }
    });
});
