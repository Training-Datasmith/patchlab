/**
 * nerdctl-specific integration: host→container workspace copy runs through
 * nerdctl cp staging and ownership repair. Git must remain usable in the
 * workspace after provisioning (regression guard for UID mapping fixes).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../../test_helpers.js';
import { destroy_sandbox } from '../../../src/sandbox/index.js';
import { exec_container } from '../../../src/container_runtime.js';

describe('nerdctl workspace ownership after host copy', () => {
    let source_directory: string;
    const sandbox_ids: string[] = [];

    afterEach(async () => {
        for (const id of sandbox_ids) {
            await destroy_sandbox(id, { force: true });
        }
        sandbox_ids.length = 0;
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('allows git status in the sandbox workspace after files are copied from the host', async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-nerdctl-git-'));
        execFileSync('git', ['init'], { cwd: source_directory });
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'export const value = 1;\n');
        execFileSync('git', ['add', '-A'], { cwd: source_directory });
        execFileSync('git', ['commit', '-m', 'initial'], {
            cwd: source_directory,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test',
                GIT_AUTHOR_EMAIL: 'test@test',
                GIT_COMMITTER_NAME: 'test',
                GIT_COMMITTER_EMAIL: 'test@test',
            },
        });

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_ids.push(manifest.id);

        const git_status = exec_container(
            manifest.container_name,
            ['git', '-C', TEST_CONTAINER_WORKING_DIR, 'status', '--porcelain'],
        );
        expect(git_status.trim()).toBe('');

        exec_container(
            manifest.container_name,
            ['sh', '-c', `echo changed >> ${TEST_CONTAINER_WORKING_DIR}/app.ts`],
        );
        const after_edit = exec_container(
            manifest.container_name,
            ['git', '-C', TEST_CONTAINER_WORKING_DIR, 'status', '--porcelain'],
        );
        expect(after_edit).toContain('app.ts');
    }, 120_000);
});
