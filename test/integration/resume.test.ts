import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';
import { make_fake_prompter } from '../helpers/fake_prompter.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    destroy_sandbox,
    resume_sandbox,
} from '../../src/sandbox/index.js';
import {
    commit_session_to_branch,
    patchlab_branch_name,
} from '../../src/branch/index.js';
import {
    build_archive_path,
    next_session_number,
    read_session_metadata,
} from '../../src/archive.js';
import { read_manifest } from '../../src/manifest.js';
import { exec_container } from '../../src/podman.js';

const GIT_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
};

function git_in(repository: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd: repository,
        env: GIT_ENVIRONMENT,
        encoding: 'utf-8',
    });
}

function commit_clean(repository: string): void {
    git_in(repository, ['add', '-A']);
    git_in(repository, ['commit', '-m', 'initial', '--allow-empty']);
}

async function commit_current_session(manifest: { id: string; container_name: string; tool?: string }): Promise<string | null> {
    const session_number = next_session_number(manifest.id) - 1;
    const primary_repo = read_manifest(build_archive_path(manifest.id)).sources[0].repository_root;
    const metadata = read_session_metadata(manifest.id, session_number);
    if (!metadata) {
        throw new Error('session metadata missing');
    }
    const result = await commit_session_to_branch(manifest.id, session_number, {
        container_name: manifest.container_name,
        workspace: TEST_CONTAINER_WORKING_DIR,
        tool_name: manifest.tool ?? DEFAULT_TEST_TOOL,
        created_at: metadata.created_at,
        author_name: 'test',
        author_email: 'test@test',
    });
    return result.commit_shas[primary_repo] ?? null;
}

describe('resume_sandbox', () => {
    let source_directory: string;
    const cleanup_ids: string[] = [];

    beforeEach(() => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-resume-int-'));
        git_in(source_directory, ['init']);
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const original = 1;\n');
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
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('exports branch tip and overlays host untracked files (4.11)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Written after create_sandbox so the dirty-tree gate is not triggered.
        // Resume picks up files added to the host between create and resume —
        // DEFAULT_SECRET_EXCLUDES is the only thing keeping .env out, not .gitignore.
        fs.writeFileSync(path.join(source_directory, 'notes.md'), 'local notes\n');
        fs.writeFileSync(path.join(source_directory, '.env'), 'API_KEY=secret\n');

        // Modify a tracked file and commit it to the patchlab branch.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo 'const updated = 2;' > app.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        const session_one_sha = await commit_current_session(manifest);
        expect(session_one_sha).not.toBeNull();

        // Resume into a fresh container.
        const resumed = await resume_sandbox(manifest.id, { no_install: true, prompter: make_fake_prompter({ confirm: () => true }) });

        // Tracked file reflects the branch tip (the AI's modification).
        const app_content = exec_container(
            resumed.container_name,
            ['cat', 'app.ts'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        expect(app_content).toContain('const updated = 2');

        // Host untracked non-secret file (notes.md) is overlaid into the workspace.
        // Secrets are tested separately in 4.11b — they SHALL NOT be overlaid by default.
        const notes_content = exec_container(
            resumed.container_name,
            ['cat', 'notes.md'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        expect(notes_content).toContain('local notes');

        // The secret-exclusion contract is asserted in detail by 4.11b, but
        // this test exercises the same overlay code path and should carry
        // its own canary: a regression that leaked `.env` through the
        // overlay would silently pass here if we only checked `notes.md`.
        // .env is untracked and not gitignored — DEFAULT_SECRET_EXCLUDES is
        // the only thing keeping it out.
        expect(() => exec_container(
            resumed.container_name,
            ['cat', '.env'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        )).toThrow(/No such file|cannot open/i);
    });

    it('filters DEFAULT_SECRET_EXCLUDES files from the resume overlay (4.11b)', async () => {
        // Written after create_sandbox so the dirty-tree gate is not triggered.
        // DEFAULT_SECRET_EXCLUDES is the only filter keeping .env out — it is
        // untracked and not gitignored, so git ls-files would otherwise include it.
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        fs.writeFileSync(path.join(source_directory, 'notes.md'), 'local notes\n');
        fs.writeFileSync(path.join(source_directory, '.env'), 'API_KEY=secret\n');

        const resumed = await resume_sandbox(manifest.id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });

        // `.env` is filtered: cat exits non-zero, exec_container throws.
        expect(() => exec_container(
            resumed.container_name,
            ['cat', '.env'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        )).toThrow(/No such file/);

        // notes.md (untracked, not gitignored, not a secret pattern) IS overlaid —
        // sanity check that the overlay path runs at all in this scenario.
        const notes_content = exec_container(
            resumed.container_name,
            ['cat', 'notes.md'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        expect(notes_content).toContain('local notes');
    });

    it('preserves file modes for executable scripts (4.12)', async () => {
        // Add an executable script to the host repo and commit it.
        const script_path = path.join(source_directory, 'run.sh');
        fs.writeFileSync(script_path, '#!/bin/sh\necho hello\n');
        fs.chmodSync(script_path, 0o755); // NOSONAR -- test that executable bit is preserved
        git_in(source_directory, ['add', 'run.sh']);
        git_in(source_directory, ['update-index', '--chmod=+x', 'run.sh']);
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // The script is on the branch's parent commit (host HEAD when the branch was created),
        // so the branch tip's tree contains it whether or not a session is committed.
        const resumed = await resume_sandbox(manifest.id, { no_install: true, prompter: make_fake_prompter({ confirm: () => true }) });

        // Executable bit should be preserved by `git archive | tar -x`.
        const stat_output = exec_container(
            resumed.container_name,
            ['stat', '-c', '%a', 'run.sh'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        // POSIX file mode in octal — at minimum the user-exec bit (0o100) must be set.
        const mode_octal = Number.parseInt(stat_output.trim(), 8);
        expect(mode_octal & 0o100).toBe(0o100);
    });

    it('is independent of host git state — does not double-apply (4.13)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Make a session change and commit it to the patchlab branch.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo 'const updated = 2;' > app.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        const session_sha = await commit_current_session(manifest);
        expect(session_sha).not.toBeNull();

        // Now also apply the change directly to the host's working tree (simulating user
        // having already cherry-picked the session). Commit it on the host.
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const updated = 2;\n');
        commit_clean(source_directory);

        // Capture the patchlab branch tip on the host BEFORE resume — resume
        // is supposed to be read-only against the archive branch. A bug that
        // wrote a new commit on `patchlab/<id>` during resume would not be
        // caught by the in-container content assertions below.
        const branch_name = patchlab_branch_name(manifest.id);
        const branch_tip_before = git_in(source_directory, ['rev-parse', branch_name]).trim();

        const resumed = await resume_sandbox(manifest.id, { no_install: true, prompter: make_fake_prompter({ confirm: () => true }) });

        // The resumed sandbox's app.ts must reflect the branch tip exactly — not have the
        // change applied twice or merged with the host file.
        const app_content = exec_container(
            resumed.container_name,
            ['cat', 'app.ts'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        expect(app_content.trim()).toBe('const updated = 2;');

        // Counting the literal text occurrences guards against accidental concatenation.
        const occurrences = (app_content.match(/const updated = 2/g) ?? []).length;
        expect(occurrences).toBe(1);

        // Branch tip unchanged: read-only invariant locked.
        const branch_tip_after = git_in(source_directory, ['rev-parse', branch_name]).trim();
        expect(branch_tip_after).toBe(branch_tip_before);
    });

    it('resumed sandbox has valid HEAD so extraction works (4.14)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);

        // Commit the original session.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo 'const updated = 2;' > app.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        await commit_current_session(manifest);

        const resumed = await resume_sandbox(manifest.id, { no_install: true, prompter: make_fake_prompter({ confirm: () => true }) });

        // HEAD must exist inside the resumed container so extraction's
        // `git add -A && git diff --cached --binary HEAD` works.
        const head_output = exec_container(
            resumed.container_name,
            ['git', 'rev-parse', 'HEAD'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        expect(head_output.trim()).toMatch(/^[0-9a-f]+$/);

        // Make a new change in the resumed sandbox and commit it as the next session.
        exec_container(
            resumed.container_name,
            ['sh', '-c', "echo 'const next = 3;' >> app.ts"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );
        const next_session_sha = await commit_current_session(resumed);
        expect(next_session_sha).not.toBeNull();
    });

    /**
     * Regression: when source_path is a subdirectory of the host repo, the resumed
     * workspace must contain ONLY that subtree. Pre-fix, `git archive <branch>` produced
     * tar entries from the repo root, polluting the workspace with everything outside
     * source_prefix and breaking the host-overlay collision check (which compared
     * source-relative paths against repo-root-relative branch paths).
     */
    it('resume from a subdirectory source extracts only that subtree (regression: critical-2)', async () => {
        // Create a repo with files OUTSIDE the source subdirectory. Under
        // the single-repository-subpaths layout, a source at
        // `monorepo/subproject` mounts at `${cwd}/subproject/` (NOT
        // flattened to the workspace root), so file paths everywhere in this
        // test carry the `subproject/` prefix.
        const monorepo = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-monorepo-'));
        try {
            git_in(monorepo, ['init']);
            fs.writeFileSync(path.join(monorepo, 'README.md'), '# monorepo\n');
            fs.mkdirSync(path.join(monorepo, 'subproject'));
            fs.writeFileSync(path.join(monorepo, 'subproject', 'app.ts'), 'const x = 1;\n');
            fs.writeFileSync(path.join(monorepo, 'subproject', '.gitignore'), '.env\n');
            commit_clean(monorepo);

            const subproject = path.join(monorepo, 'subproject');
            const manifest = await create_sandbox_from_directory(subproject, { no_install: true });
            cleanup_ids.push(manifest.id);

            // Modify the tracked file at its mount path under the new
            // layout (`${cwd}/subproject/app.ts`).
            exec_container(
                manifest.container_name,
                ['sh', '-c', "echo 'const updated = 2;' > subproject/app.ts"],
                { cwd: TEST_CONTAINER_WORKING_DIR }
            );
            await commit_current_session(manifest);

            // Capture branch tip BEFORE resume — same read-only invariant
            // as test 4.13.
            const branch_name = patchlab_branch_name(manifest.id);
            const branch_tip_before = git_in(monorepo, ['rev-parse', branch_name]).trim();

            const resumed = await resume_sandbox(manifest.id, { no_install: true, prompter: make_fake_prompter({ confirm: () => true }) });

            // app.ts (under source_prefix) must reflect the AI's edit.
            const app = exec_container(
                resumed.container_name,
                ['cat', 'subproject/app.ts'],
                { cwd: TEST_CONTAINER_WORKING_DIR }
            );
            expect(app).toContain('const updated = 2');

            // README.md lives at the REPO ROOT, OUTSIDE source_prefix. It must NOT be
            // present in the resumed workspace.
            const top_listing = exec_container(
                resumed.container_name,
                ['ls'],
                { cwd: TEST_CONTAINER_WORKING_DIR }
            );
            expect(top_listing).not.toContain('README.md');
            // The mount directory IS present at the workspace top level.
            expect(top_listing).toContain('subproject');

            // And the subproject mount contains app.ts.
            const subproject_listing = exec_container(
                resumed.container_name,
                ['ls', 'subproject'],
                { cwd: TEST_CONTAINER_WORKING_DIR }
            );
            expect(subproject_listing).toContain('app.ts');

            // Dotfile survival: `.gitignore` was committed under the source
            // prefix; a regression that dropped dotfiles from
            // `git archive --prefix` (same class as the original critical-2
            // bug) would not be caught by `app.ts` content alone.
            const subproject_all = exec_container(
                resumed.container_name,
                ['ls', '-a', 'subproject'],
                { cwd: TEST_CONTAINER_WORKING_DIR }
            );
            expect(subproject_all).toContain('.gitignore');

            // Branch tip unchanged: resume read-only invariant.
            const branch_tip_after = git_in(monorepo, ['rev-parse', branch_name]).trim();
            expect(branch_tip_after).toBe(branch_tip_before);
        } finally {
            fs.rmSync(monorepo, { recursive: true, force: true });
        }
    });
});
