import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';
import { make_fake_prompter } from '../helpers/fake_prompter.js';

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
} from '../../src/branch/index.js';
import {
    build_session_path,
    next_session_number,
    read_session_metadata,
} from '../../src/archive.js';
import { exec_container } from '../../src/podman.js';
import { get_provider } from '../../src/tools/index.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import { extract_workspace_copies, type Copy_Specification } from '../../src/sandbox/workspace_copies.js';

const GIT_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
};

function git_in(repository: string, arguments_: string[]): string {
    return execFileSync('git', arguments_, {
        cwd: repository,
        env: GIT_ENVIRONMENT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function commit_clean(repository: string): void {
    git_in(repository, ['add', '-A']);
    git_in(repository, ['commit', '-m', 'initial', '--allow-empty']);
}

async function commit_current_session(manifest: { id: string; container_name: string; tool?: string }): Promise<void> {
    const session_number = next_session_number(manifest.id) - 1;
    const metadata = read_session_metadata(manifest.id, session_number);
    if (!metadata) {
        throw new Error('session metadata missing');
    }
    await commit_session_to_branch(manifest.id, session_number, {
        container_name: manifest.container_name,
        workspace: TEST_CONTAINER_WORKING_DIR,
        tool_name: manifest.tool ?? DEFAULT_TEST_TOOL,
        created_at: metadata.created_at,
        author_name: 'test',
        author_email: 'test@test',
    });
}

describe('--copy workspace copies', () => {
    let source_directory: string;
    let copy_source_directory: string;
    let original_home: string | undefined;
    let original_userprofile: string | undefined;
    let home_root: string;
    const cleanup_ids: string[] = [];

    beforeEach(() => {
        home_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-copy-home-'));
        original_home = process.env.HOME;
        original_userprofile = process.env.USERPROFILE;
        process.env.HOME = home_root;
        process.env.USERPROFILE = home_root;

        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-copy-src-'));
        copy_source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-copy-files-'));

        git_in(source_directory, ['init']);
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const original = 1;\n');
        commit_clean(source_directory);
    });

    afterEach(async () => {
        for (const id of cleanup_ids) {
            try {
                await destroy_sandbox(id, { force: true });
            } catch {
                // ignore cleanup errors
            }
        }
        cleanup_ids.length = 0;
        fs.rmSync(source_directory, { recursive: true, force: true });
        fs.rmSync(copy_source_directory, { recursive: true, force: true });
        if (original_home === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = original_home;
        }
        if (original_userprofile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = original_userprofile;
        }
        fs.rmSync(home_root, { recursive: true, force: true });
    });

    it('5.1 — non-gitignored --copy file appears in container workspace and baseline commit', async () => {
        const copy_file = path.join(copy_source_directory, 'tracked.txt');
        fs.writeFileSync(copy_file, 'hello from host\n');
        const copy_specification: Copy_Specification = { source_path: copy_file, destination: 'tracked.txt' };

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [copy_specification],
        });
        cleanup_ids.push(manifest.id);

        const container_content = exec_container(
            manifest.container_name,
            ['cat', 'tracked.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(container_content).toContain('hello from host');

        const tracked_files = exec_container(
            manifest.container_name,
            ['git', 'ls-files'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(tracked_files).toContain('tracked.txt');

        const archive_file = build_session_path(manifest.id, 1, path.join('workspace-copies', 'tracked.txt'));
        expect(fs.existsSync(archive_file)).toBe(true);
        expect(fs.readFileSync(archive_file, 'utf-8')).toContain('hello from host');
    });

    it('5.2 — gitignored --copy file is present in workspace but NOT in baseline commit', async () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'injected.txt\n');
        git_in(source_directory, ['add', '.gitignore']);
        git_in(source_directory, ['commit', '-m', 'add gitignore']);

        const copy_file = path.join(copy_source_directory, 'injected.txt');
        fs.writeFileSync(copy_file, 'gitignored content\n');
        const copy_specification: Copy_Specification = { source_path: copy_file, destination: 'injected.txt' };

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [copy_specification],
        });
        cleanup_ids.push(manifest.id);

        const container_content = exec_container(
            manifest.container_name,
            ['cat', 'injected.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(container_content).toContain('gitignored content');

        const tracked_files = exec_container(
            manifest.container_name,
            ['git', 'ls-files'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(tracked_files).not.toContain('injected.txt');
    });

    it('5.3 — resume without --copy still has the file', async () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'persist.txt\n');
        git_in(source_directory, ['add', '.gitignore']);
        git_in(source_directory, ['commit', '-m', 'add gitignore']);

        const copy_file = path.join(copy_source_directory, 'persist.txt');
        fs.writeFileSync(copy_file, 'persisted content\n');
        const copy_specification: Copy_Specification = { source_path: copy_file, destination: 'persist.txt' };

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [copy_specification],
        });
        cleanup_ids.push(manifest.id);

        await commit_current_session(manifest);

        const resumed = await resume_sandbox(manifest.id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });

        const container_content = exec_container(
            resumed.container_name,
            ['cat', 'persist.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(container_content).toContain('persisted content');
    });

    it('5.5 — directory --copy copies contents recursively under the destination', async () => {
        const fixtures_directory = path.join(copy_source_directory, 'fixtures');
        fs.mkdirSync(path.join(fixtures_directory, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(fixtures_directory, 'top.txt'), 'top-level file\n');
        fs.writeFileSync(path.join(fixtures_directory, 'nested', 'deep.txt'), 'nested file\n');

        const copy_specification: Copy_Specification = {
            source_path: fixtures_directory,
            destination: 'test/fixtures',
        };

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [copy_specification],
        });
        cleanup_ids.push(manifest.id);

        const top_content = exec_container(
            manifest.container_name,
            ['cat', 'test/fixtures/top.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(top_content).toContain('top-level file');

        const deep_content = exec_container(
            manifest.container_name,
            ['cat', 'test/fixtures/nested/deep.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(deep_content).toContain('nested file');
    });

    it('5.6 — file deleted by tool is restored from archive on next resume', async () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'deletable.txt\n');
        git_in(source_directory, ['add', '.gitignore']);
        git_in(source_directory, ['commit', '-m', 'add gitignore']);

        const copy_file = path.join(copy_source_directory, 'deletable.txt');
        fs.writeFileSync(copy_file, 'will be deleted\n');
        const copy_specification: Copy_Specification = {
            source_path: copy_file,
            destination: 'deletable.txt',
        };

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [copy_specification],
        });
        cleanup_ids.push(manifest.id);

        // Tool deletes the file.
        exec_container(
            manifest.container_name,
            ['rm', 'deletable.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );

        // Extraction: file is absent in container, so archive entry is left unchanged.
        const provider = get_provider(manifest.tool ?? DEFAULT_TEST_TOOL);
        const session_number = next_session_number(manifest.id) - 1;
        extract_workspace_copies(
            manifest.container_name,
            provider.image_specification.image_home,
            build_session_path(manifest.id, session_number, 'workspace-copies'),
        );

        await commit_current_session(manifest);

        // Resume: archive entry (original content) is restored.
        const resumed = await resume_sandbox(manifest.id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });

        const container_content = exec_container(
            resumed.container_name,
            ['cat', 'deletable.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(container_content).toContain('will be deleted');
    });

    it('5.7 — new --copy on resume replaces the previous session archive entry at the same destination', async () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'target.txt\n');
        git_in(source_directory, ['add', '.gitignore']);
        git_in(source_directory, ['commit', '-m', 'add gitignore']);

        const version_one_file = path.join(copy_source_directory, 'v1.txt');
        fs.writeFileSync(version_one_file, 'version one\n');
        const version_two_file = path.join(copy_source_directory, 'v2.txt');
        fs.writeFileSync(version_two_file, 'version two\n');

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [{ source_path: version_one_file, destination: 'target.txt' }],
        });
        cleanup_ids.push(manifest.id);

        await commit_current_session(manifest);

        // Resume with a new --copy that replaces the previous session's target.txt.
        const resumed = await resume_sandbox(manifest.id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
            copy_paths: [{ source_path: version_two_file, destination: 'target.txt' }],
        });

        const container_content = exec_container(
            resumed.container_name,
            ['cat', 'target.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(container_content).toContain('version two');
        expect(container_content).not.toContain('version one');
    });

    it('5.4 — extraction copy-out preserves AI modifications to --copy files', async () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'mutable.txt\n');
        git_in(source_directory, ['add', '.gitignore']);
        git_in(source_directory, ['commit', '-m', 'add gitignore']);

        const copy_file = path.join(copy_source_directory, 'mutable.txt');
        fs.writeFileSync(copy_file, 'original content\n');
        const copy_specification: Copy_Specification = { source_path: copy_file, destination: 'mutable.txt' };

        const manifest = await create_sandbox_from_directory(source_directory, {
            no_install: true,
            copy_paths: [copy_specification],
        });
        cleanup_ids.push(manifest.id);

        // Simulate the AI modifying the copied file inside the container.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "printf 'AI edited this\\n' > mutable.txt"],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );

        // Simulate the extraction step that cli.ts performs at session end.
        const provider = get_provider(manifest.tool ?? DEFAULT_TEST_TOOL);
        const session_number = next_session_number(manifest.id) - 1;
        extract_workspace_copies(
            manifest.container_name,
            provider.image_specification.image_home,
            build_session_path(manifest.id, session_number, 'workspace-copies'),
        );

        await commit_current_session(manifest);

        const resumed = await resume_sandbox(manifest.id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
        });

        const container_content = exec_container(
            resumed.container_name,
            ['cat', 'mutable.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(container_content).toContain('AI edited this');
    });
});
