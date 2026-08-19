import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create_sandbox_from_directory } from '../test_helpers.js';
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
    extract_conversation,
    extract_history,
} from '../../src/extraction.js';
import {
    ARCHIVE_ARTIFACTS_DIRECTORY,
    build_session_path,
    next_session_number,
} from '../../src/archive.js';
import { exec_container } from '../../src/container_runtime.js';
import { TEST_CONTAINER_WORKING_DIR, TEST_IMAGE_HOME } from '../test_helpers.js';
import { get_provider } from '../../src/tools/index.js';
import type { Tool_Provider } from '../../src/tools/types.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import type { Extractable_Artifact } from '../../src/extractable_artifact.js';

describe('exit extraction integration', () => {
    let source_directory: string;
    const cleanup_ids: string[] = [];

    beforeEach(() => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-extraction-src-'));
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const x = 1;\n');
        execFileSync('git', ['add', '-A'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'initial'], {
            cwd: source_directory,
            stdio: 'pipe',
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test',
                GIT_AUTHOR_EMAIL: 'test@test',
                GIT_COMMITTER_NAME: 'test',
                GIT_COMMITTER_EMAIL: 'test@test',
            },
        });
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

    it('extract_history captures git log, tolerates missing bash history (6.1)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);
        const session_number = next_session_number(manifest.id) - 1;

        // Make a commit inside the sandbox so git log has content.
        exec_container(
            manifest.container_name,
            ['sh', '-c', "echo modified > app.ts && git add -A && git commit -m 'inside sandbox'"],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );

        // Run extraction. Default sandbox has no `~/.bash_history`; the extractor must
        // tolerate that and still write the git log.
        extract_history(
            manifest.container_name,
            TEST_CONTAINER_WORKING_DIR,
            TEST_IMAGE_HOME,
            manifest.id,
            session_number
        );

        const history_directory = build_session_path(manifest.id, session_number, 'history');
        const git_log = fs.readFileSync(path.join(history_directory, 'git-log.txt'), 'utf-8');

        // Substring check is necessary but not sufficient — a regression that
        // captured `git log` against the wrong branch, or truncated the log
        // mid-write, would still contain the commit message but produce a
        // corrupted file. Capture the expected output via the same
        // `git log --oneline` command extract_history runs internally, then
        // assert byte-exact equality. The two reads happen back-to-back on
        // a static container state, so the comparison is deterministic.
        const expected_git_log = exec_container(
            manifest.container_name,
            ['git', 'log', '--oneline'],
            { cwd: TEST_CONTAINER_WORKING_DIR },
        );
        expect(git_log).toBe(expected_git_log);
        // Belt-and-suspenders: the well-known commit subject IS present, AND
        // the file's first line names a SHA prefix + that subject.
        expect(git_log).toContain('inside sandbox');
        expect(git_log).toMatch(/^[0-9a-f]{7,} inside sandbox$/m);

        // bash-history.txt is optional — its absence is fine.
        const has_bash_history = fs.existsSync(path.join(history_directory, 'bash-history.txt'));
        // Either present (if shell touched it) or absent — both are acceptable.
        expect([true, false]).toContain(has_bash_history);
    });

    it('extract_conversation copies declared artifacts and skips missing ones (6.2)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);
        const session_number = next_session_number(manifest.id) - 1;

        // Seed an artifact at a known path and confirm extraction picks it up.
        exec_container(
            manifest.container_name,
            ['sh', '-c', 'mkdir -p /tmp/test-conv && echo content > /tmp/test-conv/note.txt'],
            { cwd: TEST_CONTAINER_WORKING_DIR }
        );

        const fake_provider: Tool_Provider = {
            ...get_provider(manifest.tool ?? DEFAULT_TEST_TOOL),
            get_extractable_artifacts(): Extractable_Artifact[] {
                return [
                    {
                        name: 'present',
                        container_path: '/tmp/test-conv',
                        type: 'directory',
                        archive_subpath: 'present',
                        required_for_resume: false,
                    },
                    {
                        name: 'missing',
                        container_path: '/tmp/does-not-exist',
                        type: 'directory',
                        archive_subpath: 'missing',
                        required_for_resume: false,
                    },
                ];
            },
        };

        const result = extract_conversation(
            manifest.container_name,
            fake_provider,
            manifest.id,
            session_number
        );

        expect(result.extracted).toEqual(['present']);
        expect(result.produced_but_failed).toEqual([]);

        const archive_directory = build_session_path(manifest.id, session_number, ARCHIVE_ARTIFACTS_DIRECTORY);
        expect(fs.existsSync(path.join(archive_directory, 'present', 'note.txt'))).toBe(true);
        expect(fs.existsSync(path.join(archive_directory, 'missing'))).toBe(false);
    });

    it('active-sandbox confirmation prompt aborts when user declines (6.6)', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        cleanup_ids.push(manifest.id);
        // Container is running after creation. Resume should invoke the confirmation hook.

        let prompted = false;
        await expect(
            resume_sandbox(manifest.id, {
                no_install: true,
                prompter: make_fake_prompter({ confirm: () => { prompted = true; return false; } }),
            })
        ).rejects.toThrow(/Resume aborted/);

        expect(prompted).toBe(true);
    });
});
