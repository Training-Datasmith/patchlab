/**
 * Multi-source patchlab end-to-end tests (tasks 5.7, 6.5).
 *
 * Exercises the create → modify → exit → patchlab-branch-commit pipeline for
 * a sandbox mounting two subpaths of the same repository, plus the resume
 * pipeline that re-hydrates both mounts from the branch tip and the host
 * overlay. These tests run against the real `create_sandbox` /
 * `resume_sandbox` paths and a live podman container; the no_install:true
 * flag skips npm install to keep runtime under a minute per test.
 *
 * Key invariants verified:
 *   - The container's workspace exposes each mount at
 *     `${HOME}/workspace/<source_prefix>/` (the layout change locked by the
 *     change's `Create sandbox from source directory` requirement).
 *   - The container's `git init` lives at `${HOME}/workspace/` — modifying a
 *     file under each mount produces a single diff whose paths are
 *     repo-relative (i.e. they already carry the `src/ui/` and `src/server/`
 *     prefixes without any `git apply --directory=` re-prefixing).
 *   - The patchlab branch's session commit records both changes at their
 *     repo-relative paths.
 *   - Resume's multi-prefix `git archive <branch> -- <prefix>/ ...` pulls
 *     both subtrees back into the new sandbox at the correct mount paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { make_fake_prompter } from '../helpers/fake_prompter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { exec_runtime_cli } from '../helpers/exec_runtime_cli.js';
import {
    create_sandbox,
    resume_sandbox,
    destroy_sandbox,
} from '../../src/sandbox/index.js';
import { resolve_source_inputs } from '../../src/sources.js';
import { read_manifest, manifest_primary_source } from '../../src/manifest.js';
import {
    container_exists,
    exec_container,
} from '../../src/container_runtime.js';
import { build_archive_path, get_repository_root } from '../../src/archive.js';
import { patchlab_branch_name, commit_session_to_branch } from '../../src/branch/index.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import { TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';

const GIT_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'patchlab-test',
    GIT_AUTHOR_EMAIL: 'test@patchlab.local',
    GIT_COMMITTER_NAME: 'patchlab-test',
    GIT_COMMITTER_EMAIL: 'test@patchlab.local',
};

function git_silent(repository: string, args: string[]): void {
    execFileSync('git', args, { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
}

function init_repository_with_two_subpaths(repository: string): void {
    git_silent(repository, ['init']);
    fs.mkdirSync(path.join(repository, 'src', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(repository, 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'src', 'ui', 'app.tsx'), 'original ui\n');
    fs.writeFileSync(path.join(repository, 'src', 'server', 'routes.ts'), 'original server\n');
    fs.writeFileSync(path.join(repository, 'README.md'), 'top\n');
    git_silent(repository, ['add', '-A']);
    git_silent(repository, ['commit', '-m', 'initial']);
}

describe('multi-source patchlab — create + extract (task 5.7)', () => {
    let repository: string;
    const sandbox_ids: string[] = [];

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mpx-create-')));
        init_repository_with_two_subpaths(repository);
    });

    afterEach(async () => {
        for (const id of sandbox_ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch (_ignored) {
                // best effort
            }
        }
        sandbox_ids.length = 0;
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('mounts each source at ${HOME}/workspace/<source_prefix>/ and modifying files under each mount produces one commit with repo-relative paths', async () => {
        const ui_path = path.join(repository, 'src', 'ui');
        const server_path = path.join(repository, 'src', 'server');
        const sources = resolve_source_inputs(ui_path, [server_path]);

        return create_sandbox(sources, { no_install: true, tool: DEFAULT_TEST_TOOL }).then((manifest) => {
            sandbox_ids.push(manifest.id);

            // Verify the workspace layout: container has src/ui/ and src/server/ as top-level mounts.
            const ls = exec_container(manifest.container_name, ['ls', TEST_CONTAINER_WORKING_DIR]);
            expect(ls).toContain('src');
            const ls_src = exec_container(
                manifest.container_name,
                ['ls', `${TEST_CONTAINER_WORKING_DIR}/src`],
            );
            expect(ls_src).toContain('ui');
            expect(ls_src).toContain('server');

            // Confirm the original file contents landed at the expected paths.
            const ui_content = exec_container(
                manifest.container_name,
                ['cat', `${TEST_CONTAINER_WORKING_DIR}/src/ui/app.tsx`],
            );
            expect(ui_content.trim()).toBe('original ui');
            const server_content = exec_container(
                manifest.container_name,
                ['cat', `${TEST_CONTAINER_WORKING_DIR}/src/server/routes.ts`],
            );
            expect(server_content.trim()).toBe('original server');

            // The container's git repository is at ${HOME}/workspace/, not per-mount.
            const top_level = exec_container(
                manifest.container_name,
                ['git', 'rev-parse', '--show-toplevel'],
                { cwd: TEST_CONTAINER_WORKING_DIR },
            );
            expect(top_level.trim()).toBe(TEST_CONTAINER_WORKING_DIR);

            // Modify a file under each mount.
            exec_container(
                manifest.container_name,
                ['sh', '-c', `echo "edited ui" > ${TEST_CONTAINER_WORKING_DIR}/src/ui/app.tsx`],
            );
            exec_container(
                manifest.container_name,
                ['sh', '-c', `echo "edited server" > ${TEST_CONTAINER_WORKING_DIR}/src/server/routes.ts`],
            );

            // Stage and emit the diff inside the container — the paths should
            // already be repo-relative (src/ui/..., src/server/...) because the
            // container's git baseline is at the workspace root.
            exec_container(
                manifest.container_name,
                ['git', 'add', '-A'],
                { cwd: TEST_CONTAINER_WORKING_DIR },
            );
            const diff_output = exec_container(
                manifest.container_name,
                ['git', 'diff', '--cached', 'HEAD'],
                { cwd: TEST_CONTAINER_WORKING_DIR },
            );
            expect(diff_output).toMatch(/diff --git a\/src\/ui\/app\.tsx b\/src\/ui\/app\.tsx/);
            expect(diff_output).toMatch(/diff --git a\/src\/server\/routes\.ts b\/src\/server\/routes\.ts/);
        });
    }, 180_000);
});

describe('multi-source patchlab — resume (task 6.5)', () => {
    let repository: string;
    const sandbox_ids: string[] = [];

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mpx-resume-')));
        init_repository_with_two_subpaths(repository);
    });

    afterEach(async () => {
        for (const id of sandbox_ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch (_ignored) {
                // best effort
            }
        }
        sandbox_ids.length = 0;
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('resume re-hydrates both mounts from the branch tip at the correct mount paths', async () => {
        const ui_path = path.join(repository, 'src', 'ui');
        const server_path = path.join(repository, 'src', 'server');
        const sources = resolve_source_inputs(ui_path, [server_path]);
        const manifest = await create_sandbox(sources, { no_install: true, tool: DEFAULT_TEST_TOOL });
        sandbox_ids.push(manifest.id);

        // Drop a session commit on the patchlab branch directly so resume
        // has something to extract. We add a new file under each mount at
        // repo-relative paths (matching the layout the container would
        // produce).
        const branch = patchlab_branch_name(manifest.id);
        const branch_tip = execFileSync(
            'git', ['rev-parse', `refs/heads/${branch}`],
            { cwd: repository, env: GIT_ENVIRONMENT, encoding: 'utf-8' },
        ).trim();
        const temporary_index = path.join(
            os.tmpdir(),
            `patchlab-mpx-test-${Date.now()}.idx`,
        );
        try {
            execFileSync('git', ['read-tree', branch_tip], {
                cwd: repository,
                env: { ...GIT_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
                stdio: 'pipe',
            });
            // Add a UI file.
            const ui_blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
                cwd: repository, env: GIT_ENVIRONMENT, input: 'session ui content\n', encoding: 'utf-8',
            }).trim();
            execFileSync('git',
                ['update-index', '--add', '--cacheinfo', `100644,${ui_blob},src/ui/new-ui.txt`],
                { cwd: repository, env: { ...GIT_ENVIRONMENT, GIT_INDEX_FILE: temporary_index }, stdio: 'pipe' },
            );
            // Add a server file.
            const server_blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
                cwd: repository, env: GIT_ENVIRONMENT, input: 'session server content\n', encoding: 'utf-8',
            }).trim();
            execFileSync('git',
                ['update-index', '--add', '--cacheinfo', `100644,${server_blob},src/server/new-server.txt`],
                { cwd: repository, env: { ...GIT_ENVIRONMENT, GIT_INDEX_FILE: temporary_index }, stdio: 'pipe' },
            );
            const tree = execFileSync('git', ['write-tree'], {
                cwd: repository,
                env: { ...GIT_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
                encoding: 'utf-8',
            }).trim();
            const session_commit = execFileSync(
                'git',
                ['commit-tree', tree, '-p', branch_tip, '-m', 'session: add files in both mounts'],
                { cwd: repository, env: GIT_ENVIRONMENT, encoding: 'utf-8' },
            ).trim();
            execFileSync('git', ['update-ref', `refs/heads/${branch}`, session_commit], {
                cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe',
            });
        } finally {
            try {
                fs.unlinkSync(temporary_index);
            } catch (_ignored) {
                // best effort
            }
        }

        // Resume directly — `prompter: make_fake_prompter({ confirm: () => true })` waves
        // through the existing-container guard. resume_sandbox stops the
        // prior container itself and creates a fresh one; we never call
        // destroy_sandbox here because that would also force-delete the
        // patchlab branch (and break the resume).
        //
        // `resume_sandbox` reuses the container NAME
        // (`container_name_for(patchlab_id)` is deterministic, used by both
        // `create_sandbox` and `resume_sandbox`), so the name alone cannot
        // distinguish prior from new — we capture the prior container's ID
        // and assert the post-resume container at that name has a different
        // ID. A regression that left the prior container running (e.g.
        // skipped `clean_up_previous_container`) would surface either as a
        // resume failure ("container name already in use") OR as the
        // post-resume ID matching the prior ID.
        const prior_container_name = manifest.container_name;
        const prior_container_id = exec_runtime_cli(
            ['container', 'inspect', '--format', '{{.Id}}', prior_container_name],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();

        const resumed = await resume_sandbox(manifest.id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });
        sandbox_ids.push(resumed.id);

        // Container at the prior name exists (resume reuses the name) but
        // is a DIFFERENT container instance — its ID changed.
        expect(container_exists(resumed.container_name)).toBe(true);
        const post_resume_container_id = exec_runtime_cli(
            ['container', 'inspect', '--format', '{{.Id}}', resumed.container_name],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
        expect(post_resume_container_id).not.toBe(prior_container_id);

        // Confirm both session commit files landed at their mount paths.
        const ui_new = exec_container(
            resumed.container_name,
            ['cat', `${TEST_CONTAINER_WORKING_DIR}/src/ui/new-ui.txt`],
        );
        expect(ui_new.trim()).toBe('session ui content');

        const server_new = exec_container(
            resumed.container_name,
            ['cat', `${TEST_CONTAINER_WORKING_DIR}/src/server/new-server.txt`],
        );
        expect(server_new.trim()).toBe('session server content');

        // Read the persisted manifest and confirm sources array round-tripped.
        const persisted = read_manifest(build_archive_path(resumed.id));
        expect(persisted.sources).toHaveLength(2);
        expect(persisted.sources.map((s) => s.source_prefix).sort((a, b) => a.localeCompare(b))).toEqual(['src/server', 'src/ui']);
        const primary = manifest_primary_source(persisted);
        expect(primary.source_prefix).toBe('src/ui');
    }, 240_000);
});

describe('multi-repository patchlab — create + destroy (multi-source-lifecycle task 6)', () => {
    // `repository_a` and `repository_b` hold the CANONICAL repository_root form
    // (what git's `rev-parse --show-toplevel` returns) so direct string equality
    // works against manifest/details values. On Windows the OS-native `mkdtemp`
    // path uses backslashes but git emits forward slashes — canonicalizing once
    // up-front lets the assertions compare byte-for-byte.
    let repository_a: string;
    let repository_b: string;
    const sandbox_ids: string[] = [];

    beforeEach(() => {
        const a_native = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mpx-repo-a-')));
        const b_native = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mpx-repo-b-')));
        // Each repository gets one source directory with its own initial commit.
        for (const repository of [a_native, b_native]) {
            git_silent(repository, ['init']);
            fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
            const label = repository === a_native ? 'repo-a' : 'repo-b';
            fs.writeFileSync(path.join(repository, 'src', `${label}.txt`), `${label} initial\n`);
            fs.writeFileSync(path.join(repository, 'README.md'), `${label}\n`);
            git_silent(repository, ['add', '-A']);
            git_silent(repository, ['commit', '-m', 'initial']);
        }
        repository_a = get_repository_root(a_native);
        repository_b = get_repository_root(b_native);
    });

    afterEach(async () => {
        for (const id of sandbox_ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch (_ignored) {
                /* best effort */
            }
        }

        sandbox_ids.length = 0;
        fs.rmSync(repository_a, { recursive: true, force: true });
        fs.rmSync(repository_b, { recursive: true, force: true });
    });

    it('creates one patchlab/{id} branch in EACH host repository and inspect enumerates both (task 6.1)', async () => {
        const ui_a = path.join(repository_a, 'src');
        const ui_b = path.join(repository_b, 'src');
        const sources = resolve_source_inputs(
            { host_path: ui_a, mount_name: 'a-src' },
            [{ host_path: ui_b, mount_name: 'b-src' }],
        );

        const manifest = await create_sandbox(sources, { no_install: true, tool: DEFAULT_TEST_TOOL });
        sandbox_ids.push(manifest.id);

        const branch = patchlab_branch_name(manifest.id);
        const branch_a = execFileSync('git', ['rev-parse', branch], { cwd: repository_a, encoding: 'utf-8' }).trim();
        const branch_b = execFileSync('git', ['rev-parse', branch], { cwd: repository_b, encoding: 'utf-8' }).trim();
        expect(branch_a).toMatch(/^[0-9a-f]{40}$/);
        expect(branch_b).toMatch(/^[0-9a-f]{40}$/);

        // Inspect enumerates BOTH repositories with their branch tips.
        const { inspect_sandbox } = await import('../../src/sandbox/index.js');
        const details = inspect_sandbox(manifest.id);
        const compare_paths = (a: string, b: string): number => a.localeCompare(b);
        expect(details.repositories.map((r) => r.repository_root).sort(compare_paths))
            .toEqual([repository_a, repository_b].sort(compare_paths));
        for (const entry of details.repositories) {
            expect(entry.branch_exists).toBe(true);
            expect(entry.branch_tip).toMatch(/^[0-9a-f]{40}$/);
        }

        // Manifest records two sources with their respective repository_root values.
        const persisted = read_manifest(build_archive_path(manifest.id));
        expect(persisted.sources).toHaveLength(2);
        const repositories = persisted.sources.map((s) => s.repository_root).sort(compare_paths);
        expect(repositories).toEqual([repository_a, repository_b].sort(compare_paths));

        // Destroy deletes both branches and removes the archive.
        const result = await destroy_sandbox(manifest.id, { force: true });
        // Remove from cleanup list since destroy already ran.
        sandbox_ids.length = 0;
        expect(result.archive_removed).toBe(true);
        expect(result.branch_outcomes[repository_a]).toBe('deleted');
        expect(result.branch_outcomes[repository_b]).toBe('deleted');
        expect(fs.existsSync(build_archive_path(manifest.id))).toBe(false);
    }, 240_000);

    it('reports per-repository outcomes when one repository skips due to unapplied commits (task 6.3)', async () => {
        const ui_a = path.join(repository_a, 'src');
        const ui_b = path.join(repository_b, 'src');
        const sources = resolve_source_inputs(
            { host_path: ui_a, mount_name: 'a-src' },
            [{ host_path: ui_b, mount_name: 'b-src' }],
        );

        const manifest = await create_sandbox(sources, { no_install: true, tool: DEFAULT_TEST_TOOL });
        sandbox_ids.push(manifest.id);

        const branch = patchlab_branch_name(manifest.id);
        // Add an unapplied session commit to BOTH repos' patchlab branches so
        // the destroy path consults the per-repository confirm hook.
        for (const repository of [repository_a, repository_b]) {
            execFileSync('git', ['checkout', '-b', 'work', branch], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
            fs.writeFileSync(path.join(repository, 'session.txt'), `session in ${repository}\n`);
            execFileSync('git', ['add', '-A'], { cwd: repository, env: GIT_ENVIRONMENT });
            execFileSync('git', ['commit', '-m', 'session-commit'], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
            const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
            execFileSync('git', ['checkout', '-'], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
            execFileSync('git', ['branch', '-D', 'work'], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
            execFileSync('git', ['update-ref', `refs/heads/${branch}`, tip], { cwd: repository, env: GIT_ENVIRONMENT });
        }

        // Decline confirm for repository A; accept for repository B.
        const result = await destroy_sandbox(manifest.id, {
            confirm: (repository_root) => repository_root !== repository_a,
        });
        expect(result.branch_outcomes[repository_a]).toBe('skipped');
        expect(result.branch_outcomes[repository_b]).toBe('deleted');
        // Archive retained because A was skipped.
        expect(result.archive_removed).toBe(false);
        expect(fs.existsSync(build_archive_path(manifest.id))).toBe(true);
    }, 240_000);
});

describe('multi-repository patchlab — commit fan-out (multi-source-extraction task 7)', () => {
    let repository_a: string;
    let repository_b: string;
    const sandbox_ids: string[] = [];

    beforeEach(() => {
        const a_native = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mext-a-')));
        const b_native = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mext-b-')));
        for (const repository of [a_native, b_native]) {
            git_silent(repository, ['init']);
            fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
            const label = repository === a_native ? 'repo-a' : 'repo-b';
            fs.writeFileSync(path.join(repository, 'src', `${label}.txt`), `${label} initial\n`);
            fs.writeFileSync(path.join(repository, 'README.md'), `${label}\n`);
            git_silent(repository, ['add', '-A']);
            git_silent(repository, ['commit', '-m', 'initial']);
        }
        repository_a = get_repository_root(a_native);
        repository_b = get_repository_root(b_native);
    });

    afterEach(async () => {
        for (const id of sandbox_ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch (_ignored) {
                // best effort
            }
        }
        sandbox_ids.length = 0;
        fs.rmSync(repository_a, { recursive: true, force: true });
        fs.rmSync(repository_b, { recursive: true, force: true });
    });

    it('fans out a session commit to BOTH repositories when files in both mounts changed (task 7.1)', async () => {
        const ui_a = path.join(repository_a, 'src');
        const ui_b = path.join(repository_b, 'src');
        const sources = resolve_source_inputs(
            { host_path: ui_a, mount_name: 'a-src' },
            [{ host_path: ui_b, mount_name: 'b-src' }],
        );

        const manifest = await create_sandbox(sources, { no_install: true, tool: DEFAULT_TEST_TOOL });
        sandbox_ids.push(manifest.id);

        // Modify a file under EACH mount in the container.
        exec_container(
            manifest.container_name,
            ['sh', '-c', `echo "edited a" > ${TEST_CONTAINER_WORKING_DIR}/a-src/repo-a.txt`],
        );
        exec_container(
            manifest.container_name,
            ['sh', '-c', `echo "edited b" > ${TEST_CONTAINER_WORKING_DIR}/b-src/repo-b.txt`],
        );

        const result = await commit_session_to_branch(manifest.id, 1, {
            container_name: manifest.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: DEFAULT_TEST_TOOL,
            created_at: new Date().toISOString(),
            author_name: 'patchlab-test',
            author_email: 'test@patchlab.local',
        });

        // BOTH repositories got commits; no fallbacks.
        expect(result.commit_shas[repository_a]).toMatch(/^[0-9a-f]{40}$/);
        expect(result.commit_shas[repository_b]).toMatch(/^[0-9a-f]{40}$/);
        expect(result.fallback_patches[repository_a]).toBeNull();
        expect(result.fallback_patches[repository_b]).toBeNull();

        // Each repository's branch advanced to the new SHA.
        const branch = patchlab_branch_name(manifest.id);
        const tip_a = execFileSync('git', ['rev-parse', branch], { cwd: repository_a, encoding: 'utf-8' }).trim();
        const tip_b = execFileSync('git', ['rev-parse', branch], { cwd: repository_b, encoding: 'utf-8' }).trim();
        expect(tip_a).toBe(result.commit_shas[repository_a]);
        expect(tip_b).toBe(result.commit_shas[repository_b]);
    }, 240_000);

    it('writes a per-repository fallback patch when one repository\'s branch has been deleted (task 7.2)', async () => {
        const ui_a = path.join(repository_a, 'src');
        const ui_b = path.join(repository_b, 'src');
        const sources = resolve_source_inputs(
            { host_path: ui_a, mount_name: 'a-src' },
            [{ host_path: ui_b, mount_name: 'b-src' }],
        );

        const manifest = await create_sandbox(sources, { no_install: true, tool: DEFAULT_TEST_TOOL });
        sandbox_ids.push(manifest.id);

        // Manually delete repository_b's patchlab branch BEFORE the fan-out.
        const branch = patchlab_branch_name(manifest.id);
        execFileSync('git', ['branch', '-D', branch], { cwd: repository_b, env: GIT_ENVIRONMENT, stdio: 'pipe' });

        // Modify a file under EACH mount in the container.
        exec_container(
            manifest.container_name,
            ['sh', '-c', `echo "edited a" > ${TEST_CONTAINER_WORKING_DIR}/a-src/repo-a.txt`],
        );
        exec_container(
            manifest.container_name,
            ['sh', '-c', `echo "edited b" > ${TEST_CONTAINER_WORKING_DIR}/b-src/repo-b.txt`],
        );

        const result = await commit_session_to_branch(manifest.id, 1, {
            container_name: manifest.container_name,
            workspace: TEST_CONTAINER_WORKING_DIR,
            tool_name: DEFAULT_TEST_TOOL,
            created_at: new Date().toISOString(),
            author_name: 'patchlab-test',
            author_email: 'test@patchlab.local',
        });

        // Repository A committed; repository B got a fallback patch.
        expect(result.commit_shas[repository_a]).toMatch(/^[0-9a-f]{40}$/);
        expect(result.commit_shas[repository_b]).toBeNull();
        expect(result.fallback_patches[repository_a]).toBeNull();
        const fallback_path = result.fallback_patches[repository_b];
        expect(fallback_path).not.toBeNull();
        expect(typeof fallback_path).toBe('string');
        expect(fs.existsSync(fallback_path as string)).toBe(true);
        // Fallback content includes the modified file's path (in the slice's
        // mount-name form before any rewrite — `b-src/repo-b.txt`, NOT
        // `src/repo-b.txt`) and the actual edit. A regression that produced
        // a syntactically-malformed diff or a diff with the wrong content
        // would pass the path-substring check alone.
        const fallback_content = fs.readFileSync(fallback_path as string, 'utf-8');
        expect(fallback_content).toContain('b-src/repo-b.txt');
        expect(fallback_content).toContain('edited b');
        // Unified-diff format markers.
        expect(fallback_content).toMatch(/^diff --git /m);
        expect(fallback_content).toMatch(/^\+\+\+ /m);
        expect(fallback_content).toMatch(/^--- /m);

        // The fallback is in the slice's mount-name layout, so a host repo
        // whose paths match (rather than `repository_b` itself, which uses
        // `src/repo-b.txt`) can verify the patch applies cleanly. Build that
        // verification target and run `git apply --check`. A corrupted patch
        // — one with bad line offsets, mangled hunks, or stale context —
        // would fail this dry-run check even though it superficially looks
        // like a diff to the substring assertions above.
        const apply_target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mpx-fallback-target-')));
        try {
            execFileSync('git', ['init', '-q'], { cwd: apply_target, env: GIT_ENVIRONMENT, stdio: 'pipe' });
            const apply_b_src = path.join(apply_target, 'b-src');
            fs.mkdirSync(apply_b_src, { recursive: true });
            // Pre-edit content of repo-b's tracked file (from beforeEach
            // setup). This is what `create_sandbox`'s baseline carried
            // into the container.
            fs.writeFileSync(path.join(apply_b_src, 'repo-b.txt'), 'repo-b initial\n');
            execFileSync('git', ['add', '-A'], { cwd: apply_target, env: GIT_ENVIRONMENT, stdio: 'pipe' });
            execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: apply_target, env: GIT_ENVIRONMENT, stdio: 'pipe' });

            expect(() => execFileSync(
                'git',
                ['apply', '--check', fallback_path as string],
                { cwd: apply_target, env: GIT_ENVIRONMENT, stdio: 'pipe' },
            )).not.toThrow();
        } finally {
            fs.rmSync(apply_target, { recursive: true, force: true });
        }
    }, 240_000);

});
