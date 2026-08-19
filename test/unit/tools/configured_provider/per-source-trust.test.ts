/**
 * Tests for the per-source trust mechanism:
 *
 *   - `compute_trusted_manifests_hash` (task 6.7, 6.8): hash changes on
 *     add/edit/delete; includes byte contents of malformed manifests
 *   - `read_trust_marker` / `write_trust_marker` round-trip (task 6.5);
 *     malformed marker treated as absent
 *   - `confirm_per_source_manifests` behaviors (task 6.6, 6.18):
 *     TTY accept/decline, non-TTY default/strict/allow, conflicting flags,
 *     minimum-disclosure warning content
 *   - `verify_per_source_trust` short-circuits on matching marker
 *   - Marker key derives from `realpath(repository_root)` (task 6.20)
 *   - Repo-shipped `.tools-trusted` cannot bypass the home-directory marker
 *     (task 6.17)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    compute_trusted_manifests_hash,
    type Configured_Tool_Provider_Manifest,
    type Manifest_Parse_Error,
} from '../../../../src/tools/configured_provider/index.js';
import {
    read_trust_marker,
    write_trust_marker,
    trust_marker_path,
} from '../../../../src/tools/configured_provider/trust_marker.js';
import {
    confirm_per_source_manifests,
    verify_per_source_trust,
    verify_per_source_trust_multi_repository,
    is_per_source_unconfirmed,
    Conflicting_Flags_Error,
    Trust_Declined_Error,
} from '../../../../src/tools/configured_provider/trust_verification.js';
import type { Prompter } from '../../../../src/prompts.js';

// Test-side wrapper for the migration from the old `is_tty` /
// `confirm_prompt` injection pair to a single `prompter` field. Tests that
// drove the TTY-confirm/decline branches with stub closures now build an
// inline Prompter; the `choose` method is unused by trust verification, so
// it throws if accidentally reached (catches a future spec drift).
function inline_prompter(
    confirm_function: (message: string) => Promise<boolean>,
): Prompter {
    return {
        confirm: confirm_function,
        choose: async () => { throw new Error('inline_prompter.choose unused in trust tests'); },
    };
}

function make_manifest(overrides: Partial<Configured_Tool_Provider_Manifest> = {}): Configured_Tool_Provider_Manifest {
    return {
        name: 'aider',
        display_name: 'Aider',
        image_user: 'patchlab',
        image_home: '/home/patchlab',
        configuration_directory_name: '.aider',
        base_image: 'docker.io/library/python:3.12-slim',
        base_family: 'debian',
        package_manager: 'apt',
        dockerfile: undefined,
        authentication: { method: 'none' },
        launch_command: ['aider'],
        validation: undefined,
        extractable_artifacts: [],
        overrides_builtin: false,
        ...overrides,
    };
}

describe('compute_trusted_manifests_hash', () => {
    it('returns the sha256-of-empty for an empty buffer map (task 3.1 edge case)', () => {
        const hash = compute_trusted_manifests_hash(new Map());
        // sha256 of zero bytes
        expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('changes when manifest bytes change (task 6.7)', () => {
        const buffers_a = new Map([['/manifests/aider.yaml', Buffer.from('name: aider\n')]]);
        const buffers_b = new Map([['/manifests/aider.yaml', Buffer.from('name: aider2\n')]]);
        expect(compute_trusted_manifests_hash(buffers_a))
            .not.toBe(compute_trusted_manifests_hash(buffers_b));
    });

    it('changes when a manifest is added or removed (task 6.7)', () => {
        const one = new Map([['/manifests/a.yaml', Buffer.from('one')]]);
        const two = new Map([
            ['/manifests/a.yaml', Buffer.from('one')],
            ['/manifests/b.yaml', Buffer.from('two')],
        ]);
        expect(compute_trusted_manifests_hash(one))
            .not.toBe(compute_trusted_manifests_hash(two));
    });

    it('is sort-order independent (sorts by filename ASCII)', () => {
        const ab = new Map([
            ['/manifests/a.yaml', Buffer.from('one')],
            ['/manifests/b.yaml', Buffer.from('two')],
        ]);
        const ba = new Map([
            ['/manifests/b.yaml', Buffer.from('two')],
            ['/manifests/a.yaml', Buffer.from('one')],
        ]);
        expect(compute_trusted_manifests_hash(ab)).toBe(compute_trusted_manifests_hash(ba));
    });

    it('binds file boundaries: layouts sharing one concatenated byte stream no longer collide', () => {
        // Under the previous bare `\n`-join these collided: a single file `A\nB`
        // joined to the same bytes as files `A` and `B` (`"A" + "\n" + "B"`).
        // Binding each entry's filename and byte length separates them.
        const single_file = new Map([['/manifests/a.yaml', Buffer.from('A\nB')]]);
        const split_files = new Map([
            ['/manifests/a.yaml', Buffer.from('A')],
            ['/manifests/ab.yaml', Buffer.from('B')],
        ]);
        expect(compute_trusted_manifests_hash(single_file))
            .not.toBe(compute_trusted_manifests_hash(split_files));
    });

    it('binds the filename: renaming a manifest changes the hash even when its bytes are identical', () => {
        const named_a = new Map([['/manifests/a.yaml', Buffer.from('name: aider\n')]]);
        const named_b = new Map([['/manifests/b.yaml', Buffer.from('name: aider\n')]]);
        expect(compute_trusted_manifests_hash(named_a))
            .not.toBe(compute_trusted_manifests_hash(named_b));
    });

    it('fingerprints bytes regardless of parse-ability (task 6.8)', () => {
        // Two buffers — one well-formed YAML, one malformed
        const malformed = new Map([
            ['/manifests/a.yaml', Buffer.from('not: valid: yaml: at-all\n  more bad-indent\n')],
        ]);
        const well_formed = new Map([
            ['/manifests/a.yaml', Buffer.from('name: aider\n')],
        ]);
        const malformed_hash = compute_trusted_manifests_hash(malformed);
        const well_formed_hash = compute_trusted_manifests_hash(well_formed);
        expect(malformed_hash).not.toBe(well_formed_hash);
        // Both produce valid sha256 hex (64 chars)
        expect(malformed_hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe('trust marker — read/write round-trip (task 6.5)', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-marker-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-marker-repo-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('returns null when no marker exists', () => {
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('round-trips: write then read yields the same trusted_hash', () => {
        const hash = 'a'.repeat(64);
        write_trust_marker(repository_root, hash);
        expect(read_trust_marker(repository_root)).toBe(hash);
    });

    it('treats malformed JSON as absent', () => {
        const marker_path = trust_marker_path(repository_root);
        fs.mkdirSync(path.dirname(marker_path), { recursive: true });
        fs.writeFileSync(marker_path, 'not-json-at-all');
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('treats marker missing required trusted_hash field as absent', () => {
        const marker_path = trust_marker_path(repository_root);
        fs.mkdirSync(path.dirname(marker_path), { recursive: true });
        fs.writeFileSync(marker_path, JSON.stringify({ confirmed_at: 'whenever' }));
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('stores the marker under PATCHLAB_HOME, NOT in the source tree (task 6.17 anti-bypass)', () => {
        write_trust_marker(repository_root, 'd'.repeat(64));
        const in_source = path.join(repository_root, '.patchlab', '.tools-trusted');
        expect(fs.existsSync(in_source)).toBe(false);
        const expected_marker_path = trust_marker_path(repository_root);
        expect(expected_marker_path.startsWith(patchlab_home)).toBe(true);
        expect(fs.existsSync(expected_marker_path)).toBe(true);
    });

    it('write produces the marker at the canonical path (task 3.3)', () => {
        const marker_path = trust_marker_path(repository_root);
        expect(fs.existsSync(marker_path)).toBe(false);
        write_trust_marker(repository_root, 'b'.repeat(64));
        expect(fs.existsSync(marker_path)).toBe(true);
        // Tempfile siblings should NOT remain — the rename moved the tempfile into the
        // canonical name. (A leaked tempfile would mean atomic-rename didn't fire.)
        const marker_directory = path.dirname(marker_path);
        const leftovers = fs.readdirSync(marker_directory).filter(
            (name) => name.includes('.tmp.'),
        );
        expect(leftovers).toEqual([]);
    });

    // Note on crash-safety (task 3.3): atomic-rename behavior is verified
    // indirectly here by the existing round-trip test plus the "no leftover
    // tempfile" check above. Directly simulating a crash between write and
    // rename would require mocking `fs.renameSync` and `fs.writeFileSync`,
    // which is not configurable on Node's ESM `node:fs` namespace — the
    // module's exports are read-only properties. The structural argument is
    // sufficient: `write_trust_marker` writes to `marker_path + .tmp.<pid>.<random>`
    // then calls `fs.renameSync` to the canonical path. If the rename throws,
    // the canonical file is untouched (rename atomicity is the OS guarantee).
    // The tempfile-name pattern `<key>.json.tmp.<pid>.<random>` is verifiable
    // by code review of `src/tools/configured_provider/trust_verification.ts`.
});

describe('trust marker — realpath-based keying (task 6.20)', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-realpath-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-realpath-repo-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('two paths with the same realpath share a marker', () => {
        if (process.platform === 'win32') {
            return; // symlinks need admin on Windows
        }

        const link_path = path.join(os.tmpdir(), `patchlab-realpath-link-${Date.now()}`);
        fs.symlinkSync(repository_root, link_path);
        try {
            write_trust_marker(repository_root, 'shared'.padEnd(64, 'a'));
            expect(read_trust_marker(link_path)).toBe('shared'.padEnd(64, 'a'));
        } finally {
            fs.unlinkSync(link_path);
        }
    });
});

describe('confirm_per_source_manifests behaviors (task 6.6, 6.18)', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-confirm-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-confirm-source-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('TTY + confirm writes the marker and returns', async () => {
        const warnings: string[] = [];
        await confirm_per_source_manifests(repository_root, [make_manifest()], [], 'a'.repeat(64), {
            output_warn: (line) => warnings.push(line),
            prompter: inline_prompter(async () => true),
        });
        expect(read_trust_marker(repository_root)).toBe('a'.repeat(64));
        expect(warnings.length).toBeGreaterThan(0);
    });

    it('TTY + decline throws Trust_Declined_Error and does NOT write the marker', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'b'.repeat(64), {
                prompter: inline_prompter(async () => false),
                output_warn: () => { /* silent */ },
            }),
        ).rejects.toBeInstanceOf(Trust_Declined_Error);
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('non-TTY default throws Trust_Declined_Error pointing at --allow-untrusted-manifests', async () => {
        let thrown: unknown;
        try {
            await confirm_per_source_manifests(repository_root, [make_manifest()], [], 'c'.repeat(64), {
                output_warn: () => { /* silent */ },
            });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Trust_Declined_Error);
        expect((thrown as Error).message).toContain('--allow-untrusted-manifests');
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('non-TTY + strict_trust matches default (warn + abort)', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'd'.repeat(64), {
                strict_trust: true,
                output_warn: () => { /* silent */ },
            }),
        ).rejects.toBeInstanceOf(Trust_Declined_Error);
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('non-TTY + allow_untrusted_manifests proceeds without writing the marker', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'e'.repeat(64), {
                allow_untrusted_manifests: true,
                output_warn: () => { /* silent */ },
            }),
        ).resolves.toBeUndefined();
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    // The interactive-prompter spec scenarios "Options-bag prompter — absent
    // field equals explicit null" and "Options-bag prompter — explicit
    // undefined equals explicit null" promise the three forms collapse to one
    // safe-default code path. The collapse happens in `trust_verification.ts`
    // at `options?.prompter ?? null`. These tests lock the equivalence
    // observably: same outcome (throw or success) and same trust-marker side
    // effect across all three forms.
    //
    // Without these, a contributor who replaced `?? null` with
    // `Boolean(options?.prompter)` (or similar) would still pass the existing
    // absent-field tests but silently break the explicit-null and explicit-
    // undefined paths — exactly the failure mode the spec scenarios exist to
    // prevent.

    it('explicit prompter: null without allow_untrusted matches absent-field behavior (throws)', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'h'.repeat(64), {
                prompter: null,
                output_warn: () => { /* silent */ },
            }),
        ).rejects.toBeInstanceOf(Trust_Declined_Error);
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('explicit prompter: undefined without allow_untrusted matches absent-field behavior (throws)', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'i'.repeat(64), {
                prompter: undefined,
                output_warn: () => { /* silent */ },
            }),
        ).rejects.toBeInstanceOf(Trust_Declined_Error);
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('explicit prompter: null with allow_untrusted matches absent-field behavior (proceeds without marker)', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'j'.repeat(64), {
                prompter: null,
                allow_untrusted_manifests: true,
                output_warn: () => { /* silent */ },
            }),
        ).resolves.toBeUndefined();
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('explicit prompter: undefined with allow_untrusted matches absent-field behavior (proceeds without marker)', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'k'.repeat(64), {
                prompter: undefined,
                allow_untrusted_manifests: true,
                output_warn: () => { /* silent */ },
            }),
        ).resolves.toBeUndefined();
        expect(read_trust_marker(repository_root)).toBeNull();
    });

    it('non-TTY + both flags throws Conflicting_Flags_Error', async () => {
        await expect(
            confirm_per_source_manifests(repository_root, [make_manifest()], [], 'f'.repeat(64), {
                strict_trust: true,
                allow_untrusted_manifests: true,
                output_warn: () => { /* silent */ },
            }),
        ).rejects.toBeInstanceOf(Conflicting_Flags_Error);
    });

    it('emits warning even when aborting (user always sees what would have run)', async () => {
        const warnings: string[] = [];
        try {
            await confirm_per_source_manifests(repository_root, [make_manifest()], [], 'g'.repeat(64), {
                output_warn: (line) => warnings.push(line),
            });
        } catch (_ignored) {
            /* expected */
        }
        expect(warnings.some((line) => line.includes('launch_command'))).toBe(true);
    });

    it('discloses minimum fields: launch_command, base_image, authentication.method, dockerfile.install (task 6.18)', async () => {
        const warnings: string[] = [];
        const manifest = make_manifest({
            base_image: 'docker.io/library/python:3.12-slim',
            authentication: {
                method: 'file_copy',
                copies: [{
                    host: '/workspace/repo/template.json',
                    container: '/home/patchlab/.tool/template.json',
                    uses_home_expansion: false,
                }],
            },
            dockerfile: { install: ['libpq-dev', 'curl'], environment: {} },
        });
        try {
            await confirm_per_source_manifests(repository_root, [manifest], [], 'h'.repeat(64), {
                output_warn: (line) => warnings.push(line),
            });
        } catch (_ignored) {
            /* expected */
        }
        const joined = warnings.join('\n');
        expect(joined).toContain('launch_command');
        expect(joined).toContain('docker.io/library/python:3.12-slim');
        expect(joined).toContain('authentication.method: file_copy');
        expect(joined).toContain('/workspace/repo/template.json');
        expect(joined).toContain('libpq-dev');
    });

    it('discloses prompt_launch_command and prompt_resume_launch_command when set', async () => {
        const warnings: string[] = [];
        const manifest = make_manifest({
            prompt_launch_command: ['my-tool', '{{prompt}}'],
            prompt_resume_launch_command: ['my-tool', '--continue', '{{prompt}}'],
        });
        try {
            await confirm_per_source_manifests(repository_root, [manifest], [], 'p'.repeat(64), {
                output_warn: (line) => warnings.push(line),
            });
        } catch (_ignored) {
            /* expected */
        }
        const joined = warnings.join('\n');
        expect(joined).toContain('prompt_launch_command');
        expect(joined).toContain('prompt_resume_launch_command');
    });

    it('renders cross-machine-reproducibility note when a host path uses `~`/`$HOME` (task 1.10 / 3.3)', async () => {
        const warnings: string[] = [];
        const manifest = make_manifest({
            authentication: {
                method: 'file_copy',
                copies: [{
                    host: '/expanded/home/user/.tool/config',
                    container: '/home/patchlab/.tool/config',
                    uses_home_expansion: true,
                }],
            },
        });
        try {
            await confirm_per_source_manifests(repository_root, [manifest], [], 'i'.repeat(64), {
                output_warn: (line) => warnings.push(line),
            });
        } catch (_ignored) {
            /* expected — non-TTY default aborts */
        }
        const joined = warnings.join('\n');
        expect(joined).toContain('host-machine-dependent');
        expect(joined).toMatch(/`~` or `\$HOME`/);
    });

    it('does NOT render cross-machine note when no host path used home expansion', async () => {
        const warnings: string[] = [];
        const manifest = make_manifest({
            authentication: {
                method: 'file_copy',
                copies: [{
                    host: '/workspace/repo/template.json',
                    container: '/home/patchlab/.tool/template.json',
                    uses_home_expansion: false,
                }],
            },
        });
        try {
            await confirm_per_source_manifests(repository_root, [manifest], [], 'j'.repeat(64), {
                output_warn: (line) => warnings.push(line),
            });
        } catch (_ignored) {
            /* expected */
        }
        expect(warnings.join('\n')).not.toContain('host-machine-dependent');
    });
});

describe('verify_per_source_trust', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-verify-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-verify-source-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('no-ops when manifest_buffers is empty (nothing to trust)', async () => {
        await expect(
            verify_per_source_trust(repository_root, new Map(), [], [], { output_warn: () => { /* silent */ } }),
        ).resolves.toBeUndefined();
    });

    it('short-circuits when the marker matches the current hash', async () => {
        const buffers = new Map([['/manifests/aider.yaml', Buffer.from('name: aider\n')]]);
        const current_hash = compute_trusted_manifests_hash(buffers);
        write_trust_marker(repository_root, current_hash);

        let prompt_called = false;
        await verify_per_source_trust(repository_root, buffers, [make_manifest()], [], {
            prompter: inline_prompter(async () => { prompt_called = true; return true; }),
            output_warn: () => { /* silent */ },
        });
        expect(prompt_called).toBe(false);
    });

    it('prompts when the marker mismatches (manifest edited)', async () => {
        const old_buffers = new Map([['/manifests/aider.yaml', Buffer.from('name: aider\n')]]);
        const new_buffers = new Map([['/manifests/aider.yaml', Buffer.from('name: aider-v2\n')]]);
        write_trust_marker(repository_root, compute_trusted_manifests_hash(old_buffers));

        let prompt_called = false;
        await verify_per_source_trust(repository_root, new_buffers, [make_manifest()], [], {
            prompter: inline_prompter(async () => { prompt_called = true; return true; }),
            output_warn: () => { /* silent */ },
        });
        expect(prompt_called).toBe(true);
        // New marker reflects new hash
        expect(read_trust_marker(repository_root)).toBe(compute_trusted_manifests_hash(new_buffers));
    });
});

/**
 * Multi-repository trust orchestration. `verify_per_source_trust_multi_repository`
 * is the entry point the Phase 1 trust hook closure ultimately invokes per repo;
 * it is also called directly from `resume_sandbox`. The orchestration is the
 * place where per-repo iteration order, buffer partitioning by manifest path,
 * the parallel-array index between `registered_manifests` and
 * `registered_manifest_repositories`, the silent-skip for repos with no
 * manifests, and the decline-fail-fast behavior all live. Spec scenarios at
 * specs/configured-tool-provider/spec.md:229-260 depend on each of these.
 */
describe('verify_per_source_trust_multi_repository', () => {
    let patchlab_home: string;
    let repository_a: string;
    let repository_b: string;
    let repository_c: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-multi-verify-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-multi-verify-repo-a-')));
        repository_b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-multi-verify-repo-b-')));
        repository_c = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-multi-verify-repo-c-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        for (const directory of [patchlab_home, repository_a, repository_b, repository_c]) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch (_ignored) {
                // best effort
            }
        }
    });

    function manifest_path_for(repository_root: string, file_name: string): string {
        return path.join(repository_root, '.patchlab', 'tools', file_name);
    }

    it('prompts for each repo in the order of `repository_roots`, in the same order on a reversed argument', async () => {
        const buffers = new Map<string, Buffer>([
            [manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')],
            [manifest_path_for(repository_b, 'helper.yaml'), Buffer.from('name: helper\n')],
        ]);
        const manifests = [make_manifest({ name: 'aider' }), make_manifest({ name: 'helper' })];
        const manifests_repositories = [repository_a, repository_b];

        const prompts_forward: string[] = [];
        await verify_per_source_trust_multi_repository(
            [repository_a, repository_b], buffers, manifests, manifests_repositories, [],
            {
                prompter: inline_prompter(async (message) => { prompts_forward.push(message); return true; }),
                output_warn: () => { /* silent */ },
            },
        );
        expect(prompts_forward).toHaveLength(2);
        expect(prompts_forward[0]).toContain(repository_a);
        expect(prompts_forward[1]).toContain(repository_b);

        // Clear markers so the reversed run actually prompts again.
        const markers_directory = path.join(patchlab_home, '.patchlab', 'trusted-sources');
        for (const file_name of fs.readdirSync(markers_directory)) {
            fs.unlinkSync(path.join(markers_directory, file_name));
        }

        const prompts_reversed: string[] = [];
        await verify_per_source_trust_multi_repository(
            [repository_b, repository_a], buffers, manifests, manifests_repositories, [],
            {
                prompter: inline_prompter(async (message) => { prompts_reversed.push(message); return true; }),
                output_warn: () => { /* silent */ },
            },
        );
        expect(prompts_reversed).toHaveLength(2);
        expect(prompts_reversed[0]).toContain(repository_b);
        expect(prompts_reversed[1]).toContain(repository_a);
    });

    it('partitions buffers by repository — each repo sees only its own manifests in its warning section', async () => {
        const buffers = new Map<string, Buffer>([
            [manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')],
            [manifest_path_for(repository_b, 'helper.yaml'), Buffer.from('name: helper\n')],
        ]);
        const manifests = [
            make_manifest({ name: 'aider', display_name: 'Aider' }),
            make_manifest({ name: 'helper', display_name: 'Helper' }),
        ];
        const manifests_repositories = [repository_a, repository_b];

        const warnings_by_repo: Record<string, string[]> = { [repository_a]: [], [repository_b]: [] };
        let current_repository: string | null = null;
        await verify_per_source_trust_multi_repository(
            [repository_a, repository_b], buffers, manifests, manifests_repositories, [],
            {
                prompter: inline_prompter(async (message) => {
                    // Trust message names a repository — track which.
                    current_repository = message.includes(repository_a) ? repository_a
                        : (message.includes(repository_b) ? repository_b : null);
                    return true;
                }),
                output_warn: (line) => {
                    // Header line names the repo for that section; tag every
                    // subsequent line with whichever repo's section we're in.
                    if (line.includes(repository_a)) {
                        current_repository = repository_a;
                    } else if (line.includes(repository_b)) {
                        current_repository = repository_b;
                    }

                    if (current_repository !== null) {
                        warnings_by_repo[current_repository].push(line);
                    }
                },
            },
        );

        const repository_a_text = warnings_by_repo[repository_a].join('\n');
        const repository_b_text = warnings_by_repo[repository_b].join('\n');
        expect(repository_a_text).toContain('aider');
        expect(repository_a_text).not.toContain('Helper');
        expect(repository_b_text).toContain('helper');
        expect(repository_b_text).not.toContain('Aider');
    });

    it('partitions parse_errors by repository — each repo prompt shows only its own rejected manifests', async () => {
        const buffers = new Map<string, Buffer>([
            [manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')],
            [manifest_path_for(repository_b, 'helper.yaml'), Buffer.from('name: helper\n')],
        ]);
        const manifests = [make_manifest({ name: 'aider' }), make_manifest({ name: 'helper' })];
        const manifests_repositories = [repository_a, repository_b];
        const parse_errors = [
            {
                manifest_path: manifest_path_for(repository_a, 'broken-a.yaml'),
                field_path: '',
                reason: 'REPO_A_PARSE_FAILURE',
            },
            {
                manifest_path: manifest_path_for(repository_b, 'broken-b.yaml'),
                field_path: '',
                reason: 'REPO_B_PARSE_FAILURE',
            },
        ];

        // Count total occurrences across BOTH prompts: when partitioned each
        // error renders exactly once (in its own repo's prompt); the previous
        // unpartitioned behavior rendered every error in every repo's prompt,
        // which for two repos would be twice each.
        const all_lines: string[] = [];
        await verify_per_source_trust_multi_repository(
            [repository_a, repository_b], buffers, manifests, manifests_repositories, parse_errors,
            {
                prompter: inline_prompter(async () => true),
                output_warn: (line) => { all_lines.push(line); },
            },
        );

        expect(all_lines.filter((line) => line.includes('REPO_A_PARSE_FAILURE'))).toHaveLength(1);
        expect(all_lines.filter((line) => line.includes('REPO_B_PARSE_FAILURE'))).toHaveLength(1);
    });

    it('silently skips a repository whose buffer partition is empty (spec: a repo with no manifests does not prompt)', async () => {
        const buffers = new Map<string, Buffer>([
            [manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')],
            // repository_b contributes NO manifests; its `.patchlab/tools/`
            // partition will be empty after `partition_buffers_by_repository`.
        ]);
        const manifests = [make_manifest({ name: 'aider' })];
        const manifests_repositories = [repository_a];

        const prompts: string[] = [];
        await verify_per_source_trust_multi_repository(
            [repository_a, repository_b], buffers, manifests, manifests_repositories, [],
            {
                prompter: inline_prompter(async (message) => { prompts.push(message); return true; }),
                output_warn: () => { /* silent */ },
            },
        );
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain(repository_a);
        // No marker for repository_b — nothing was confirmed there.
        expect(read_trust_marker(repository_b)).toBeNull();
        expect(read_trust_marker(repository_a)).not.toBeNull();
    });

    it('decline of repo N short-circuits — repos N+1..end are not prompted and the earlier repos\' markers persist (Decision 7)', async () => {
        const buffers = new Map<string, Buffer>([
            [manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')],
            [manifest_path_for(repository_b, 'helper.yaml'), Buffer.from('name: helper\n')],
            [manifest_path_for(repository_c, 'tester.yaml'), Buffer.from('name: tester\n')],
        ]);
        const manifests = [
            make_manifest({ name: 'aider' }),
            make_manifest({ name: 'helper' }),
            make_manifest({ name: 'tester' }),
        ];
        const manifests_repositories = [repository_a, repository_b, repository_c];

        const prompts_in_order: string[] = [];
        let invocation_count = 0;
        await expect(
            verify_per_source_trust_multi_repository(
                [repository_a, repository_b, repository_c], buffers, manifests, manifests_repositories, [],
                {
                    prompter: inline_prompter(async (message) => {
                        invocation_count += 1;
                        prompts_in_order.push(message);
                        // Confirm repo A; decline repo B; repo C must not be reached.
                        return invocation_count === 1;
                    }),
                    output_warn: () => { /* silent */ },
                },
            ),
        ).rejects.toBeInstanceOf(Trust_Declined_Error);

        expect(prompts_in_order).toHaveLength(2);
        expect(prompts_in_order[0]).toContain(repository_a);
        expect(prompts_in_order[1]).toContain(repository_b);
        // Decision 7: repo A's marker IS persisted (the confirmation was real).
        expect(read_trust_marker(repository_a)).toBe(compute_trusted_manifests_hash(
            new Map([[manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')]]),
        ));
        // Repo B was declined — no marker.
        expect(read_trust_marker(repository_b)).toBeNull();
        // Repo C was never reached — no marker.
        expect(read_trust_marker(repository_c)).toBeNull();
    });

    it('parallel-array indexing: a manifest at index i is attributed to manifests_repositories[i], not arbitrary repo', async () => {
        // Cross-attribution test: the manifest order in `registered_manifests`
        // intentionally does NOT match the natural sort that `partition_buffers_by_repository`
        // would produce. If the implementation accidentally re-derived the
        // per-repo manifest list from the buffer keys instead of using the
        // parallel array, this test would silently pass. Instead we observe the
        // warning content per repo and verify each repo's section shows ONLY
        // the manifest whose `manifests_repositories[i]` equals that repo's
        // path. The buffers map order is reversed so a naive iteration would
        // produce a wrong assignment.
        const buffers = new Map<string, Buffer>([
            [manifest_path_for(repository_b, 'helper.yaml'), Buffer.from('name: helper\n')],
            [manifest_path_for(repository_a, 'aider.yaml'), Buffer.from('name: aider\n')],
        ]);
        // Parallel arrays: manifest[0] belongs to repository_a, manifest[1] belongs to repository_b.
        const manifests = [
            make_manifest({ name: 'aider', display_name: 'Aider-Disclosed-Here' }),
            make_manifest({ name: 'helper', display_name: 'Helper-Disclosed-Here' }),
        ];
        const manifests_repositories = [repository_a, repository_b];

        const repository_a_lines: string[] = [];
        const repository_b_lines: string[] = [];
        let active_section: 'a' | 'b' | null = null;
        await verify_per_source_trust_multi_repository(
            [repository_a, repository_b], buffers, manifests, manifests_repositories, [],
            {
                prompter: inline_prompter(async () => true),
                output_warn: (line) => {
                    if (line.includes(repository_a)) {
                        active_section = 'a';
                    } else if (line.includes(repository_b)) {
                        active_section = 'b';
                    }

                    if (active_section === 'a') {
                        repository_a_lines.push(line);
                    } else if (active_section === 'b') {
                        repository_b_lines.push(line);
                    }
                },
            },
        );

        const repository_a_text = repository_a_lines.join('\n');
        const repository_b_text = repository_b_lines.join('\n');
        expect(repository_a_text).toContain('Aider-Disclosed-Here');
        expect(repository_a_text).not.toContain('Helper-Disclosed-Here');
        expect(repository_b_text).toContain('Helper-Disclosed-Here');
        expect(repository_b_text).not.toContain('Aider-Disclosed-Here');
    });
});

describe('is_per_source_unconfirmed', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-unconfirmed-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-unconfirmed-source-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('returns false when there are no manifests to trust', () => {
        expect(is_per_source_unconfirmed(repository_root, new Map())).toBe(false);
    });

    it('returns true when marker is missing', () => {
        const buffers = new Map([['/manifests/aider.yaml', Buffer.from('name: aider\n')]]);
        expect(is_per_source_unconfirmed(repository_root, buffers)).toBe(true);
    });

    it('returns false when marker matches current hash', () => {
        const buffers = new Map([['/manifests/aider.yaml', Buffer.from('name: aider\n')]]);
        write_trust_marker(repository_root, compute_trusted_manifests_hash(buffers));
        expect(is_per_source_unconfirmed(repository_root, buffers)).toBe(false);
    });
});

describe('repo-shipped marker bypass is impossible (task 6.17)', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-bypass-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-bypass-repo-')));
        fs.mkdirSync(path.join(repository_root, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('a committed <source>/.patchlab/.tools-trusted is IGNORED — prompt still fires', async () => {
        // Hostile-repo simulation: marker pre-shipped in the source tree with
        // trusted_hash matching its malicious manifest.
        const manifest_buffer = Buffer.from('name: aider\n');
        const buffers = new Map([['/manifests/aider.yaml', manifest_buffer]]);
        const hostile_hash = compute_trusted_manifests_hash(buffers);
        fs.writeFileSync(
            path.join(repository_root, '.patchlab', '.tools-trusted'),
            JSON.stringify({ trusted_hash: hostile_hash }),
        );

        // Home-directory marker does NOT exist; user is on a fresh machine.
        // The trust check should fire the prompt.
        const parse_errors: Manifest_Parse_Error[] = [];
        let prompt_called = false;
        try {
            await verify_per_source_trust(repository_root, buffers, [make_manifest()], parse_errors, {
                prompter: inline_prompter(async () => { prompt_called = true; return false; }),
                output_warn: () => { /* silent */ },
            });
        } catch (_ignored) {
            /* declined */
        }
        expect(prompt_called).toBe(true);
    });
});

describe('trust marker — repository-keyed sharing (task 7.8)', () => {
    let patchlab_home: string;
    let repository_root: string;
    let original_home: string | undefined;

    beforeEach(() => {
        patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-shared-home-'));
        original_home = process.env.PATCHLAB_HOME;
        process.env.PATCHLAB_HOME = patchlab_home;
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-shared-repo-')));
    });

    afterEach(() => {
        if (original_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_home;
        }
        try {
            fs.rmSync(patchlab_home, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('two patchlabs from the same repository share one trust marker (no second prompt)', async () => {
        // The marker key derives from `realpath(repository_root)`, NOT from
        // any individual source path. Two patchlabs created against
        // different subpaths of the same repository hit the same marker.
        const manifest_buffer = Buffer.from('name: aider\n');
        const buffers = new Map([['/manifests/aider.yaml', manifest_buffer]]);

        // First "patchlab" accepts the trust prompt; the marker is written.
        let first_prompt_count = 0;
        await verify_per_source_trust(repository_root, buffers, [make_manifest()], [], {
            prompter: inline_prompter(async () => { first_prompt_count++; return true; }),
            output_warn: () => { /* silent */ },
        });
        expect(first_prompt_count).toBe(1);

        // Second "patchlab" — same repository_root, same manifest set —
        // SHALL NOT re-prompt because the marker key is identical.
        let second_prompt_count = 0;
        await verify_per_source_trust(repository_root, buffers, [make_manifest()], [], {
            prompter: inline_prompter(async () => { second_prompt_count++; return true; }),
            output_warn: () => { /* silent */ },
        });
        expect(second_prompt_count).toBe(0);
    });
});

describe('per-source manifest can reference host file outside the mount but inside the repo (task 7.9)', () => {
    let repository_root: string;

    beforeEach(() => {
        repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-containment-')));
        // Create both a mounted subpath and a sibling file that lives
        // outside any single mount but inside the repository tree.
        fs.mkdirSync(path.join(repository_root, 'src', 'ui'), { recursive: true });
        fs.mkdirSync(path.join(repository_root, 'private'), { recursive: true });
        fs.writeFileSync(path.join(repository_root, 'private', 'template.json'), '{}');
    });

    afterEach(() => {
        try {
            fs.rmSync(repository_root, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('containment check accepts a path inside the repository but outside any mounted subpath', async () => {
        // Import lazily so the assertion is scoped to this test.
        const { assert_host_path_within_source } = await import(
            '../../../../src/tools/configured_provider/index.js'
        );
        const host_path = path.join(repository_root, 'private', 'template.json');
        const result = assert_host_path_within_source(
            host_path,
            repository_root,
            '/manifests/aider.yaml',
        );
        expect(result).toBeNull();
    });
});
