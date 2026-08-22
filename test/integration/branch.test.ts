import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    destroy_sandbox,
} from '../../src/sandbox/index.js';
import {
    commit_session_to_branch,
    patchlab_branch_name,
} from '../../src/branch/index.js';
import {
    build_archive_path,
    next_session_number,
    read_session_metadata,
    write_session_metadata,
} from '../../src/archive.js';
import { read_manifest } from '../../src/manifest.js';
import { exec_container, stop_and_remove_container_best_effort } from '../../src/container_runtime.js';
import { strict as assert } from 'node:assert';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import { assert_present } from '../helpers/assert_present.js';

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
};

function git_in(directory: string, args: string[], encoding: 'utf-8' | null = 'utf-8'): string {
    return execFileSync('git', args, { cwd: directory, env: GIT_ENV, encoding: encoding ?? undefined }) as string;
}

function commit_clean(repo: string): void {
    git_in(repo, ['add', '-A']);
    git_in(repo, ['commit', '-m', 'initial', '--allow-empty']);
}

describe('branch: session commit integration', () => {
    let source_directory: string;
    const cleanup_ids: string[] = [];
    /** Containers whose archive was removed without destroy — torn down by name in afterEach. */
    const orphan_container_names: string[] = [];

    beforeEach(() => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-int-'));
        git_in(source_directory, ['init']);
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const x = 1;\n');
        fs.writeFileSync(path.join(source_directory, 'README.md'), '# project\n');
        commit_clean(source_directory);
    });

    afterEach(async () => {
        for (const id of cleanup_ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch {
                // ignore
            }
        }
        cleanup_ids.length = 0;
        for (const container_name of orphan_container_names) {
            try {
                stop_and_remove_container_best_effort(container_name);
            } catch {
                // ignore
            }
        }
        orphan_container_names.length = 0;
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    function register_orphan_container(container_name: string): void {
        orphan_container_names.push(container_name);
    }

    function primary_repo_for(manifest_id: string): string {
        const m = read_manifest(build_archive_path(manifest_id));
        return m.sources[0].repository_root;
    }

    async function commit_current_session(manifest: { id: string; container_name: string; tool?: string }): Promise<{ commit_sha: string | null; fallback_patch_path: string | null }> {
        // The session metadata was written by create_sandbox; look it up by the highest session number.
        const session_number = next_session_number(manifest.id) - 1;
        const primary_repo = primary_repo_for(manifest.id);
        const meta = read_session_metadata(manifest.id, session_number);
        if (!meta) {
            throw new Error(`session metadata missing for ${manifest.id}/${session_number}`);
        }

        const result = await commit_session_to_branch(manifest.id, session_number, {
            container_name: manifest.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: manifest.tool ?? DEFAULT_TEST_TOOL,
            created_at: meta.created_at,
            author_name: 'test',
            author_email: 'test@test',
        });
        return {
            commit_sha: result.commit_shas[primary_repo] ?? null,
            fallback_patch_path: result.fallback_patches[primary_repo] ?? null,
        };
    }

    it('5.3 commits session changes to the branch without modifying user working tree', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Capture host state before extraction.
        const before_head = git_in(source_directory, ['rev-parse', 'HEAD']).trim();
        const before_status = git_in(source_directory, ['status', '--porcelain']);

        // Modify a file inside the sandbox.
        exec_container(manifest.container_name, ['sh', '-c', "echo 'const x = 2;' > app.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });

        const result = await commit_current_session(manifest);
        expect(result.commit_sha).not.toBeNull();
        expect(result.fallback_patch_path).toBeNull();

        // The host's current branch and working tree are unchanged.
        const after_head = git_in(source_directory, ['rev-parse', 'HEAD']).trim();
        const after_status = git_in(source_directory, ['status', '--porcelain']);
        expect(after_head).toBe(before_head);
        expect(after_status).toBe(before_status);

        // The new commit lives on the patchlab branch and contains the modification.
        const branch = patchlab_branch_name(manifest.id);
        const branch_tip = git_in(source_directory, ['rev-parse', branch]).trim();
        expect(branch_tip).toBe(result.commit_sha);

        const diff = git_in(source_directory, ['show', branch_tip]);
        expect(diff).toContain('app.ts');
        expect(diff).toContain('const x = 2');
    });

    it('regression: source files containing UTF-8 multi-byte characters extract without corruption', async () => {
        // Bug: passing a binary diff via Buffer.toString('binary') re-encoded multi-byte bytes
        // as UTF-8 over stdin, corrupting any patch with non-ASCII content. This test ensures
        // diffs containing emoji, accented chars, smart quotes, and CJK round-trip exactly.
        const utf8_payload = 'const greeting = "café — 你好 👋";\n// «smart quotes» and ñ\n';
        const utf8_path = path.join(source_directory, 'utf8.ts');
        fs.writeFileSync(utf8_path, 'const greeting = "hello";\n', 'utf-8');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Write the UTF-8 content from inside the container so we know the bytes were transmitted
        // through the diff pipeline.
        const shell_escaped_payload = utf8_payload.replaceAll("'", String.raw`'\''`);
        exec_container(
            manifest.container_name,
            ['sh', '-c', `printf '%s' '${shell_escaped_payload}' > utf8.ts`],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );

        const result = await commit_current_session(manifest);
        assert_present(result.commit_sha);
        expect(result.fallback_patch_path).toBeNull();

        // The committed tree must contain the exact UTF-8 bytes — not corrupted/re-encoded.
        const committed = execFileSync(
            'git',
            ['show', `${result.commit_sha}:utf8.ts`],
            { cwd: source_directory }
        );
        expect(committed.toString('utf-8')).toBe(utf8_payload);
    });

    it('5.4 untracked files inside the sandbox appear in the session commit', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        exec_container(manifest.container_name, ['sh', '-c', "echo 'fresh' > new-file.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });

        const result = await commit_current_session(manifest);
        assert_present(result.commit_sha);

        const diff = git_in(source_directory, ['show', '--stat', result.commit_sha]);
        expect(diff).toContain('new-file.ts');
    });

    it('5.5 second session commit only contains second session changes', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Session 1: modify app.ts.
        exec_container(manifest.container_name, ['sh', '-c', "echo 'const x = 2;' > app.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });
        const r1 = await commit_current_session(manifest);
        expect(r1.commit_sha).not.toBeNull();

        // Commit the AI's change to the sandbox baseline so the next session diffs from there.
        exec_container(manifest.container_name, ['git', 'add', '-A'], { cwd: TEST_CONTAINER_WORKING_DIR });
        exec_container(manifest.container_name, ['git', 'commit', '-m', 'session 1 done', '--allow-empty'], { cwd: TEST_CONTAINER_WORKING_DIR });

        // Session 2: write a new initial-session metadata and modify a different file.
        const session_number = 2;
        const created_at = new Date().toISOString();
        const primary_repo = primary_repo_for(manifest.id);
        write_session_metadata(manifest.id, session_number, {
            session_number,
            created_at,
            completed_at: null,
            status: 'completed',
            tool: DEFAULT_TEST_TOOL,
            container_name: manifest.container_name,
            commit_shas: { [primary_repo]: null },
            fallback_patches: { [primary_repo]: null },
            resource_limits: null,
        });
        exec_container(manifest.container_name, ['sh', '-c', "echo 'README updated' > README.md"], { cwd: TEST_CONTAINER_WORKING_DIR });

        const r2 = await commit_session_to_branch(manifest.id, session_number, {
            container_name: manifest.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: DEFAULT_TEST_TOOL,
            created_at,
            author_name: 'test',
            author_email: 'test@test',
        });
        const r2_commit_sha = r2.commit_shas[primary_repo] ?? null;
        assert_present(r2_commit_sha);

        // The session-2 commit should reference README.md but NOT app.ts (which was already committed in session 1).
        const stat = git_in(source_directory, ['show', '--stat', '--name-only', r2_commit_sha]);
        expect(stat).toContain('README.md');
        expect(stat).not.toContain('app.ts');

        // Branch history should be linear: session1 → session2.
        const log = git_in(source_directory, ['log', '--format=%H', patchlab_branch_name(manifest.id)]);
        const shas = log.trim().split('\n');
        expect(shas[0]).toBe(r2_commit_sha);
        expect(shas[1]).toBe(r1.commit_sha);
    });

    it('5.6 commit lands at the repo-relative path when source is a subdirectory', async () => {
        // Restructure the source: code lives at <repo>/app, and we create a
        // patchlab from there. Under the single-repository-subpaths layout
        // the source mounts at ${HOME}/workspace/app/, and the container's
        // git baseline at ${HOME}/workspace/ already records files at
        // repo-relative paths — the host-side `git apply` no longer needs a
        // `--directory=app` rewrite.
        const subdir = path.join(source_directory, 'app');
        fs.mkdirSync(subdir);
        fs.writeFileSync(path.join(subdir, 'index.ts'), 'export const v = 1;\n');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(subdir, { no_install: true });
        cleanup_ids.push(manifest.id);

        // The file lives at ${cwd}/app/index.ts under the new layout —
        // modify it there, not at the workspace root.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo 'export const v = 2;' > app/index.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );

        const result = await commit_current_session(manifest);
        assert_present(result.commit_sha);

        const stat = git_in(source_directory, ['show', '--stat', '--name-only', result.commit_sha]);
        expect(stat).toContain('app/index.ts');
        expect(stat).not.toMatch(/^index\.ts$/m);
    });

    it('5.10 binary file changes (add, modify, delete) survive extraction', async () => {
        // Add a baseline binary file.
        const png_bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
        fs.writeFileSync(path.join(source_directory, 'fixed.bin'), png_bytes);
        fs.writeFileSync(path.join(source_directory, 'changeme.bin'), Buffer.from([1, 2, 3, 4]));
        fs.writeFileSync(path.join(source_directory, '.gitattributes'), '*.bin binary\n');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Add new binary, modify existing binary, delete one.
        exec_container(manifest.container_name, ['sh', '-c',
            String.raw`printf '\x00\x01\x02\xff' > new.bin && printf '\x09\x08\x07\x06' > changeme.bin && rm fixed.bin`
        ], { cwd: TEST_CONTAINER_WORKING_DIR });

        const result = await commit_current_session(manifest);
        assert_present(result.commit_sha);

        const stat = git_in(source_directory, ['show', '--stat', '--name-status', result.commit_sha]);
        expect(stat).toMatch(/A\s+new\.bin/);
        expect(stat).toMatch(/M\s+changeme\.bin/);
        expect(stat).toMatch(/D\s+fixed\.bin/);
    });

    it('5.13 manual branch deletion before extraction falls back to a patch file', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        exec_container(manifest.container_name, ['sh', '-c', "echo 'const x = 99;' > app.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });

        // Manually delete the patchlab branch on the host before extraction.
        const branch = patchlab_branch_name(manifest.id);
        git_in(source_directory, ['branch', '-D', branch]);

        const result = await commit_current_session(manifest);
        expect(result.commit_sha).toBeNull();
        assert(result.fallback_patch_path);
        expect(fs.existsSync(result.fallback_patch_path)).toBe(true);

        // Fallback file lives under the session directory.
        const session_number = next_session_number(manifest.id) - 1;
        const expected_dir = path.join(build_archive_path(manifest.id), 'sessions', String(session_number));
        expect(result.fallback_patch_path.startsWith(expected_dir)).toBe(true);

        // The fallback should contain the diff content.
        const fallback_content = fs.readFileSync(result.fallback_patch_path, 'utf-8');
        expect(fallback_content).toContain('app.ts');
        expect(fallback_content).toContain('const x = 99');
    });

    it('container HEAD advances after commit_session_to_branch (locks the advance_container_head success path)', async () => {
        // `commit_session_to_branch` calls `advance_container_head` at the end
        // of the fan-out so the NEXT session's `git diff --cached HEAD`
        // doesn't re-stage already-committed work. The call is wrapped in a
        // try-catch that only warns on failure — a regression where the
        // advance silently fails would let session 2 re-include session 1's
        // commits. This test pins the success-path invariant.
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        exec_container(manifest.container_name, ['sh', '-c', "echo 'const x = 2;' > app.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });

        const head_before = exec_container(
            manifest.container_name,
            ['git', '-C', TEST_CONTAINER_WORKING_DIR, 'rev-parse', 'HEAD'],
        ).trim();

        const result = await commit_current_session(manifest);
        expect(result.commit_sha).not.toBeNull();
        expect(result.fallback_patch_path).toBeNull();

        const head_after = exec_container(
            manifest.container_name,
            ['git', '-C', TEST_CONTAINER_WORKING_DIR, 'rev-parse', 'HEAD'],
        ).trim();
        expect(head_after).not.toBe(head_before);
    });

    it('atomicity: apply failure on the host leaves the patchlab branch tip unchanged', async () => {
        // Different failure mode from 5.13 (branch-deleted before extract):
        // here the branch EXISTS but the host has diverged underneath it, so
        // `git apply` rejects. A regression that partially mutated the branch
        // on apply failure would leave the tip at a different SHA than before
        // the apply ran. This locks the all-or-nothing contract.
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        exec_container(manifest.container_name, ['sh', '-c', "echo 'const x = 2;' > app.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });

        const branch = patchlab_branch_name(manifest.id);
        const original_user_branch = git_in(source_directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

        // Force the host patchlab branch tip to a content that diverges from
        // BOTH the baseline (`const x = 1;`) AND the sandbox edit
        // (`const x = 2;`). The session diff's context will no longer match,
        // so the apply rejects.
        git_in(source_directory, ['switch', branch]);
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const x = 99;\n');
        git_in(source_directory, ['commit', '-am', 'host-side divergent change']);
        const branch_tip_before_apply = git_in(source_directory, ['rev-parse', branch]).trim();
        git_in(source_directory, ['switch', original_user_branch]);

        const result = await commit_current_session(manifest);

        // Apply rejected → fallback written, no new commit on the branch.
        expect(result.commit_sha).toBeNull();
        assert(result.fallback_patch_path);
        expect(fs.existsSync(result.fallback_patch_path)).toBe(true);

        // Atomicity: the patchlab branch tip is byte-identical to the SHA we
        // captured before the failed apply ran.
        const branch_tip_after_apply = git_in(source_directory, ['rev-parse', branch]).trim();
        expect(branch_tip_after_apply).toBe(branch_tip_before_apply);
    });

    it('5.15 host CRLF files do not produce spurious line-ending diffs in the sandbox baseline', async () => {
        // Create a file with CRLF line endings on the host.
        const crlf_path = path.join(source_directory, 'crlf.txt');
        fs.writeFileSync(crlf_path, 'line one\r\nline two\r\nline three\r\n');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Without modifying anything in the sandbox, extract. The diff should be empty —
        // the sandbox's core.autocrlf=false / core.eol=lf config preserves bytes.
        const result = await commit_current_session(manifest);
        expect(result.commit_sha).toBeNull();
        expect(result.fallback_patch_path).toBeNull();
    });

    it('5.12 large multi-MB binary diff extracts via streaming without buffer errors', async () => {
        // Add a baseline binary file so the diff is purely a modification.
        const baseline_size = 4 * 1024 * 1024; // 4 MB
        fs.writeFileSync(path.join(source_directory, 'large.bin'), Buffer.alloc(baseline_size, 0xaa));
        fs.writeFileSync(path.join(source_directory, '.gitattributes'), '*.bin binary\n');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Replace the file's contents inside the container with a different multi-MB pattern.
        // This forces a large binary diff that would exceed the default exec maxBuffer (1MB).
        // The fill is done via dd-like loop with printf; total bytes ~5 MB.
        exec_container(
            manifest.container_name,
            ['sh', '-c', 'head -c 5242880 /dev/urandom > large.bin'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );

        const result = await commit_current_session(manifest);
        assert_present(result.commit_sha);
        expect(result.fallback_patch_path).toBeNull();

        const stat = git_in(source_directory, ['show', '--stat', '--name-status', result.commit_sha]);
        expect(stat).toMatch(/M\s+large\.bin/);
    });

    it('5.17 freshly created sandbox has a valid HEAD for extraction', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // git rev-parse HEAD inside the sandbox should succeed and produce a SHA.
        const sandbox_head = exec_container(
            manifest.container_name,
            ['git', 'rev-parse', 'HEAD'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        ).trim();
        expect(sandbox_head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('5.16 gc cleans up orphan patchlab branches whose archive directory is missing', async () => {
        // Set up two patchlabs in the same source repo.
        const m1 = await create_sandbox_from_directory(source_directory, { no_install: true });
        const m2 = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(m1.id);
        register_orphan_container(m2.container_name);

        const branch1 = patchlab_branch_name(m1.id);
        const branch2 = patchlab_branch_name(m2.id);
        expect(git_in(source_directory, ['rev-parse', '--verify', branch1]).trim()).toMatch(/^[0-9a-f]{40}$/);
        expect(git_in(source_directory, ['rev-parse', '--verify', branch2]).trim()).toMatch(/^[0-9a-f]{40}$/);

        // Manually remove m2's archive directory so its branch becomes an orphan.
        // (Both archives still exist after create; we delete just m2's archive without going through destroy.)
        const m2_archive = build_archive_path(m2.id);
        fs.rmSync(m2_archive, { recursive: true, force: true });

        // Run gc — m1 is current (recent + container running), so it shouldn't be destroyed; but
        // gc should still find and clean up m2's orphan branch even though m2 isn't listed anymore
        // (since its archive is gone).
        const { garbage_collect_sandboxes } = await import('../../src/sandbox/index.js');
        await garbage_collect_sandboxes({ include_missing: false });

        // m1's branch should still exist; m2's orphan branch should be cleaned up.
        expect(git_in(source_directory, ['rev-parse', '--verify', '--quiet', branch1]).trim()).toMatch(/^[0-9a-f]{40}$/);

        // For m2's orphan branch, expect verify to fail (or branch to be deleted).
        let orphan_exists = true;
        try {
            git_in(source_directory, ['rev-parse', '--verify', '--quiet', branch2]);
        } catch (_ignored) {
            orphan_exists = false;
        }
        expect(orphan_exists).toBe(false);

        // m2's archive is gone so destroy_sandbox cannot run; its container is in orphan_container_names.
    });

    /**
     * Helper: build an orphan patchlab branch carrying an unapplied session
     * commit, plus a co-tenant sandbox whose manifest keeps the repo in gc's
     * scan set after the orphan's archive is removed.
     *
     * Returns the repository root (forward-slash form from the manifest), the
     * branch name, and the surviving sandbox id (for cleanup).
     */
    async function build_orphan_with_unapplied_commit(): Promise<{
        repository_root: string;
        branch: string;
        survivor_id: string;
    }> {
        const survivor = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(survivor.id);

        const orphan = await create_sandbox_from_directory(source_directory, { no_install: true });
        const branch = patchlab_branch_name(orphan.id);
        const repository_root = orphan.sources[0].repository_root;

        exec_container(orphan.container_name, ['sh', '-c', "echo 'unapplied change' > app.ts"], { cwd: TEST_CONTAINER_WORKING_DIR });
        const session_number = next_session_number(orphan.id) - 1;
        const session_metadata = read_session_metadata(orphan.id, session_number);
        if (!session_metadata) {
            throw new Error('session metadata missing');
        }
        const commit_result = await commit_session_to_branch(orphan.id, session_number, {
            container_name: orphan.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: orphan.tool ?? DEFAULT_TEST_TOOL,
            created_at: session_metadata.created_at,
            author_name: 'test',
            author_email: 'test@test',
        });
        session_metadata.commit_shas = commit_result.commit_shas;
        session_metadata.fallback_patches = commit_result.fallback_patches;
        write_session_metadata(orphan.id, session_number, session_metadata);

        // Orphan the branch: drop the archive directory without going through destroy.
        register_orphan_container(orphan.container_name);
        fs.rmSync(build_archive_path(orphan.id), { recursive: true, force: true });

        return { repository_root, branch, survivor_id: survivor.id };
    }

    it('5.17 gc skips orphan branch with unapplied session commits when no force and no confirm hook', async () => {
        const { repository_root, branch, survivor_id } = await build_orphan_with_unapplied_commit();

        const { garbage_collect_sandboxes } = await import('../../src/sandbox/index.js');
        const result = await garbage_collect_sandboxes({ include_missing: false });

        // Unapplied check rejects deletion in non-interactive mode without force.
        expect(result.orphan_outcomes[repository_root]?.[branch]).toBe('skipped');
        expect(git_in(source_directory, ['rev-parse', '--verify', '--quiet', branch]).trim())
            .toMatch(/^[0-9a-f]{40}$/);

        // Cleanup: archive is gone, so destroy can't run. Force-delete the branch directly.
        git_in(source_directory, ['branch', '-D', branch]);
        cleanup_ids.length = 0;
        cleanup_ids.push(survivor_id);
    });

    it('5.18 gc with force deletes orphan branch even with unapplied session commits', async () => {
        const { repository_root, branch, survivor_id } = await build_orphan_with_unapplied_commit();

        const { garbage_collect_sandboxes } = await import('../../src/sandbox/index.js');
        const result = await garbage_collect_sandboxes({ include_missing: false, force: true });

        expect(result.orphan_outcomes[repository_root]?.[branch]).toBe('deleted');
        let orphan_exists = true;
        try {
            git_in(source_directory, ['rev-parse', '--verify', '--quiet', branch]);
        } catch (_ignored) {
            orphan_exists = false;
        }
        expect(orphan_exists).toBe(false);
        cleanup_ids.length = 0;
        cleanup_ids.push(survivor_id);
    });

    it('5.19 gc consults confirm_orphan_branch_deletion when orphan has unapplied commits', async () => {
        const { repository_root, branch, survivor_id } = await build_orphan_with_unapplied_commit();

        // Hook receives (repository_root, branch, unapplied_count) and returns
        // true → orphan deleted.
        const calls: { repository_root: string; branch: string; unapplied_count: number }[] = [];
        const { garbage_collect_sandboxes } = await import('../../src/sandbox/index.js');
        const result = await garbage_collect_sandboxes({
            include_missing: false,
            confirm_orphan_branch_deletion: async (repository_root_arg, branch_arg, unapplied_count) => {
                calls.push({ repository_root: repository_root_arg, branch: branch_arg, unapplied_count });
                return true;
            },
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].repository_root).toBe(repository_root);
        expect(calls[0].branch).toBe(branch);
        expect(calls[0].unapplied_count).toBeGreaterThan(0);
        expect(result.orphan_outcomes[repository_root]?.[branch]).toBe('deleted');
        cleanup_ids.length = 0;
        cleanup_ids.push(survivor_id);
    });

    /**
     * Regression: oversized session diffs are gated by the size cap. With no
     * confirmation hook supplied (non-interactive caller), the auto-commit aborts
     * cleanly and the diff is preserved as `fallback.patch` so no work is lost.
     */
    it('aborts auto-commit when diff exceeds cap and no confirm hook is supplied (regression: high-7)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Make a small change inside the sandbox.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo 'const x = 2;' > app.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );

        // Pass a tiny cap (1 byte) so any non-empty diff trips it.
        const session_number = next_session_number(manifest.id) - 1;
        const primary_repo = primary_repo_for(manifest.id);
        const metadata = read_session_metadata(manifest.id, session_number);
        if (!metadata) {
            throw new Error('session metadata missing');
        }
        const result = await commit_session_to_branch(manifest.id, session_number, {
            container_name: manifest.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: DEFAULT_TEST_TOOL,
            created_at: metadata.created_at,
            author_name: 'test',
            author_email: 'test@test',
            max_diff_size_bytes: 1,
            // confirm_oversized intentionally omitted — non-interactive abort path.
        });

        const result_commit_sha = result.commit_shas[primary_repo] ?? null;
        const result_fallback = result.fallback_patches[primary_repo] ?? null;
        expect(result_commit_sha).toBeNull();
        assert_present(result_fallback);
        expect(fs.existsSync(result_fallback)).toBe(true);
        // The fallback contains the diff, not an empty file.
        expect(fs.statSync(result_fallback).size).toBeGreaterThan(0);
    });

    it('proceeds with auto-commit when diff exceeds cap and confirm_oversized returns true (regression: high-7)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo 'const x = 3;' > app.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );

        let prompted_size_bytes = 0;
        const session_number = next_session_number(manifest.id) - 1;
        const primary_repo = primary_repo_for(manifest.id);
        const metadata = read_session_metadata(manifest.id, session_number);
        if (!metadata) {
            throw new Error('session metadata missing');
        }
        const result = await commit_session_to_branch(manifest.id, session_number, {
            container_name: manifest.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: DEFAULT_TEST_TOOL,
            created_at: metadata.created_at,
            author_name: 'test',
            author_email: 'test@test',
            max_diff_size_bytes: 1,
            confirm_oversized: (size_bytes) => {
                prompted_size_bytes = size_bytes;
                return true;
            },
        });

        expect(prompted_size_bytes).toBeGreaterThan(0);
        expect(result.commit_shas[primary_repo]).not.toBeNull();
        expect(result.fallback_patches[primary_repo]).toBeNull();
    });
});
