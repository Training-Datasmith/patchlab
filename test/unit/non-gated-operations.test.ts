/**
 * Structural locks for the four operations that MUST NOT trigger per-source
 * registration or trust verification:
 *
 *   - 6.10 `destroy_sandbox` — works from the patchlab's recorded
 *     `container_name` / `source_path`; never calls `get_provider`
 *   - 6.11 `garbage_collect_sandboxes` — iterates patchlab manifests but never calls
 *     `get_provider`; iterating per-source registration would also corrupt
 *     the registry by overwriting same-named manifests across sources
 *   - 6.12 `inspect_sandbox` — diagnostic; DOES register per-source manifests
 *     (so `get_provider` can resolve a configured tool's name) but MUST NOT
 *     verify (no prompt — `inspect` doesn't run user code). Locked via a
 *     behavior test: `vi.mock`s the two helper modules, invokes
 *     `inspect_sandbox`, and asserts `register_per_source_manifests` was
 *     called exactly once with the expected repository list AND
 *     `verify_per_source_trust_multi_repository` was never called.
 *   - 6.21 `apply_patchlab_branch` + the `apply` CLI handler — pure git
 *     operation; never calls `get_provider` or `get_launch_command`
 *
 * For 6.10 / 6.11 / 6.21-the-function the locks are FILE-LEVEL import
 * absence checks: assert the source file does not import
 * `register_per_source_manifests` or anything from
 * `configured_provider/trust_verification.js`. This is strictly stronger than the
 * function-body `.toString()` substring check it replaced — it also catches
 * a refactor that lifts the call into a sibling helper in the same file
 * (which would silently strip the substring from the operation's own body
 * while keeping the call live). The CLI handler test (6.21-the-CLI) is the
 * one remaining text slice in this file because `cli.ts` legitimately
 * imports register/verify for OTHER commands (`create`, `resume`); a
 * file-level absence check would be a false positive. See "Convert
 * remaining non-gated-operations text tests to behavior tests" in
 * `documents/potential-features.md` for the path to upgrade that case.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Wrap the two helpers in spies so the inspect-behavior test can assert the
// call shape. The factories preserve every other export and route the wrapped
// function through the original implementation, so other tests in this file
// (and elsewhere) see no behavioral change.
vi.mock('../../src/tools/index.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/tools/index.js')>();
    return {
        ...actual,
        register_per_source_manifests: vi.fn(actual.register_per_source_manifests),
    };
});

vi.mock('../../src/tools/configured_provider/trust_verification.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/tools/configured_provider/trust_verification.js')>();
    return {
        ...actual,
        verify_per_source_trust_multi_repository: vi.fn(actual.verify_per_source_trust_multi_repository),
    };
});

import { inspect_sandbox } from '../../src/sandbox/index.js';
import { handle_apply_command } from '../../src/cli.js';
import { build_archive_path } from '../../src/archive.js';
import { create_manifest, write_manifest } from '../../src/manifest.js';
import { register_per_source_manifests } from '../../src/tools/index.js';
import { verify_per_source_trust_multi_repository } from '../../src/tools/configured_provider/trust_verification.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';
import { initialize_repository_with_initial_commit } from '../helpers/git_repository.js';

const this_file = fileURLToPath(import.meta.url);
const repo_root = path.resolve(path.dirname(this_file), '..', '..');

const mock_register = register_per_source_manifests as ReturnType<typeof vi.fn>;
const mock_verify = verify_per_source_trust_multi_repository as ReturnType<typeof vi.fn>;

describe('Non-gated operations do not call per-source trust helpers', () => {
    it('src/sandbox/garbage_collection.ts (destroy_sandbox + garbage_collect_sandboxes) does not import per-source trust helpers (tasks 6.10, 6.11)', () => {
        // File-level absence check: if a refactor introduced a sibling helper
        // in this file that called `register_per_source_manifests` or anything
        // from `configured_provider/trust_verification.js`, the import declaration would
        // surface here even when the named operations' bodies don't mention
        // the symbol directly. Catches the failure mode the `.toString()`
        // version missed.
        const file_source = fs.readFileSync(path.join(repo_root, 'src', 'sandbox', 'garbage_collection.ts'), 'utf-8');
        expect(file_source).not.toContain('register_per_source_manifests');
        expect(file_source).not.toContain('verify_per_source_trust');
        expect(file_source).not.toContain('trust_verification');
        expect(file_source).not.toContain('trust_marker');
    });

    it('src/branch/apply.ts does not import per-source trust helpers (task 6.21)', () => {
        // Same file-level absence check applied to the apply flow. After the
        // branch.ts split, `apply_patchlab_branch` lives in `src/branch/apply.ts`;
        // the file-level absence assertion locks the contract for the whole
        // apply module, which is the natural granularity since none of apply's
        // responsibilities involve trust gating.
        const file_source = fs.readFileSync(path.join(repo_root, 'src', 'branch', 'apply.ts'), 'utf-8');
        expect(file_source).not.toContain('register_per_source_manifests');
        expect(file_source).not.toContain('verify_per_source_trust');
        expect(file_source).not.toContain('trust_verification');
        expect(file_source).not.toContain('trust_marker');
    });

    it('the import-path substrings used by the absence checks still match the trust module paths', () => {
        // The two tests above scan source files for import-path substrings
        // identifying the trust modules. Before the configured-provider split
        // the trust module lived at `src/tools/configured_provider_trust.ts`,
        // so the literal `configured_provider_trust` (underscore) was a valid
        // substring of every import. After the split it moved to
        // `src/tools/configured_provider/trust_verification.ts`, where the
        // underscore between `provider` and `trust` became a `/` — the
        // substring above no longer appears in any real import path, so the
        // `.not.toContain('configured_provider_trust')` checks pass even when
        // a regression DOES reintroduce a trust import. A later split also
        // carved the marker persistence into a sibling `trust_marker.ts`.
        // This test reads each canonical trust source path and asserts that
        // the substring still matches a real import; the guards above only
        // stay meaningful while they do.
        const trust_verification_source = fs.readFileSync(
            path.join(repo_root, 'src', 'tools', 'configured_provider', 'trust_verification.ts'),
            'utf-8',
        );
        const trust_marker_source = fs.readFileSync(
            path.join(repo_root, 'src', 'tools', 'configured_provider', 'trust_marker.ts'),
            'utf-8',
        );
        // Self-checks that both files exist at the expected paths.
        expect(trust_verification_source.length).toBeGreaterThan(0);
        expect(trust_marker_source.length).toBeGreaterThan(0);

        // Load-bearing: the absence checks above only mean something while the
        // substrings they search for ACTUALLY appear in real import specifiers.
        // If a module rename made `trust_verification` / `trust_marker` vanish
        // from every import path, the `.not.toContain(...)` guards would pass
        // vacuously even with a trust import reintroduced. Assert each substring
        // appears in at least one genuine import line under src/ — the real
        // import graph, not a literal the test synthesizes for itself.
        const collect_src_import_lines = (directory: string): string[] => {
            const lines: string[] = [];
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const entry_path = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    lines.push(...collect_src_import_lines(entry_path));
                } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                    for (const line of fs.readFileSync(entry_path, 'utf-8').split('\n')) {
                        if (line.includes("from '") || line.includes('from "')) {
                            lines.push(line);
                        }
                    }
                }
            }

            return lines;
        };
        const src_import_lines = collect_src_import_lines(path.join(repo_root, 'src'));
        expect(src_import_lines.some((line) => line.includes('trust_verification'))).toBe(true);
        expect(src_import_lines.some((line) => line.includes('trust_marker'))).toBe(true);
    });

});

describe('handle_apply_command does not register or verify (task 6.21 — behavior)', () => {
    install_isolated_home_hooks('patchlab-apply-behavior-');

    beforeEach(() => {
        mock_register.mockClear();
        mock_verify.mockClear();
    });

    it('completes the early-exit + manifest-read paths without calling register or verify', async () => {
        // Invoking the handler against a syntactically-valid id whose archive
        // doesn't exist exercises the host-side prelude (assert_valid_patchlab_id,
        // resolve_apply_mode, the --force / TTY gate, build_archive_path,
        // read_manifest). read_manifest throws ENOENT — every line of the
        // handler reachable BEFORE the throw is observed. Neither trust spy
        // fires because the apply command must never route through
        // per-source registration or verification.
        const valid_unknown_id = '11111111-2222-3333-4444-555555555555';
        await expect(
            handle_apply_command(valid_unknown_id, { force: true }),
        ).rejects.toThrow(/ENOENT|no such file|manifest/i);
        expect(mock_register).not.toHaveBeenCalled();
        expect(mock_verify).not.toHaveBeenCalled();
    });

    it('invalid patchlab id throws BEFORE any trust path could fire', async () => {
        // The id validator at the top of the handler is a defense-in-depth
        // gate. Even when the id is rejected, neither spy should be reached —
        // a regression that moved `assert_valid_patchlab_id` below a register
        // call would surface here.
        await expect(
            handle_apply_command('not a uuid', { force: true }),
        ).rejects.toThrow(/Invalid patchlab id/);
        expect(mock_register).not.toHaveBeenCalled();
        expect(mock_verify).not.toHaveBeenCalled();
    });

    it('non-TTY without --force exits with code 1 and reaches no trust helper', async () => {
        // The non-interactive gate at the top of the handler aborts with
        // `process.exitCode = 1` before `read_manifest` is touched. The
        // handler must NOT throw on this path (the caller observes exit code,
        // not an exception) and must NOT reach `register_per_source_manifests`
        // or `verify_per_source_trust_multi_repository` — same defense-in-depth
        // contract as the other two cases above. A regression that lowered
        // the gate below either trust call would silently pass the other two
        // tests but fail this one.
        const valid_unknown_id = '22222222-3333-4444-5555-666666666666';
        const original_is_tty = process.stdin.isTTY;
        const original_exit_code = process.exitCode;
        try {
            Object.defineProperty(process.stdin, 'isTTY', {
                value: false,
                configurable: true,
            });
            process.exitCode = 0;
            await expect(
                handle_apply_command(valid_unknown_id, {}),
            ).resolves.toBeUndefined();
            expect(process.exitCode).toBe(1);
            expect(mock_register).not.toHaveBeenCalled();
            expect(mock_verify).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', {
                value: original_is_tty,
                configurable: true,
            });
            process.exitCode = original_exit_code;
        }
    });
});

describe('inspect_sandbox registration vs verification (task 6.12 — behavior)', () => {
    install_isolated_home_hooks('patchlab-inspect-behavior-');
    let temp_source: string;
    const patchlab_id = 'pl-inspect-behavior';

    beforeAll(() => {
        temp_source = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-inspect-behavior-')));
        initialize_repository_with_initial_commit(temp_source);
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        // `install_isolated_home_hooks` swaps HOME per test, so the archive
        // directory and manifest must be re-written for every test.
        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: temp_source, repository_root: temp_source, source_prefix: '', mount_name: '' }],
            'patchlab-test',
            'patchlab/test:latest',
        );
        manifest.tool = DEFAULT_TEST_TOOL;
        write_manifest(archive_directory, manifest);

        register_default_test_tool();
        mock_register.mockClear();
        mock_verify.mockClear();
    });

    it('calls register_per_source_manifests exactly once with the manifest repository list', () => {
        // Diagnostic contract: inspect registers per-source providers so
        // `get_provider(tool_name)` can resolve configured tools whose names
        // are only defined under <repository_root>/.patchlab/tools/. The
        // spy catches a regression that drops the call OR that adds a second
        // redundant invocation — both modes the substring-on-`.toString()`
        // version it replaced would have silently allowed.
        inspect_sandbox(patchlab_id);
        expect(mock_register).toHaveBeenCalledTimes(1);
        expect(mock_register).toHaveBeenCalledWith([temp_source]);
    });

    it('never calls verify_per_source_trust_multi_repository', () => {
        // Inspect MUST NOT prompt — it doesn't run user code. The spy stays
        // at zero invocations across the entire call. Combined with the
        // positive assertion above, this locks the "register, don't verify"
        // diagnostic contract from both sides via runtime observation
        // (immune to refactors that move the call into a helper).
        inspect_sandbox(patchlab_id);
        expect(mock_verify).not.toHaveBeenCalled();
    });
});
