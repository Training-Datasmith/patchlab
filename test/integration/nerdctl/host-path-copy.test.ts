/**
 * nerdctl-specific integration: host→container copies into /home/* paths use
 * the root-assisted /tmp staging path (regression guard for OpenCode config
 * injection on Lima).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox_from_directory } from '../../test_helpers.js';
import { destroy_sandbox } from '../../../src/sandbox/index.js';
import { copy_to_container, exec_container } from '../../../src/container_runtime.js';
import { inject_provider_host_files } from '../../../src/sandbox/host_access.js';
import { OPENCODE_TOOL_NAME } from '../../../src/opencode/index.js';
import { load_configuration } from '../../../src/configuration.js';
import {
    build_image,
    PATCHLAB_TEST_LABEL,
    remove_test_images,
} from '../../../src/images.js';
import { image_exists } from '../../../src/container_runtime.js';

const TEST_TAG = 'patchlab/opencode-nerdctl-home-copy:latest';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;
const OPENCODE_CONFIG_DIR = '/home/patchlab/.config/opencode';

describe('nerdctl home-path copy', () => {
    let source_directory: string;
    const sandbox_ids: string[] = [];

    beforeAll(async () => {
        if (!image_exists(TEST_TAG)) {
            await build_image({
                tag: TEST_TAG,
                tools: [OPENCODE_TOOL_NAME],
                labels: [TEST_LABEL],
            });
        }
    }, 600_000);

    afterEach(async () => {
        for (const id of sandbox_ids) {
            await destroy_sandbox(id, { force: true });
        }
        sandbox_ids.length = 0;
        if (source_directory) {
            fs.rmSync(source_directory, { recursive: true, force: true });
        }
    });

    afterAll(() => {
        remove_test_images();
    });

    function make_source_directory(): string {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-nerdctl-home-copy-'));
        execFileSync('git', ['init'], { cwd: directory });
        fs.writeFileSync(path.join(directory, 'README.md'), '# home-path copy\n');
        execFileSync('git', ['add', '-A'], { cwd: directory });
        execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], {
            cwd: directory,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test',
                GIT_AUTHOR_EMAIL: 'test@test',
                GIT_COMMITTER_NAME: 'test',
                GIT_COMMITTER_EMAIL: 'test@test',
            },
        });
        return directory;
    }

    it('copies staged opencode configuration into /home/patchlab/.config/opencode', async () => {
        source_directory = make_source_directory();
        const loaded_configuration = load_configuration([source_directory]);

        const staging_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-opencode-staging-'));
        fs.writeFileSync(
            path.join(staging_directory, 'opencode.json'),
            JSON.stringify({ marker: 'home-path-copy-ok' }) + '\n',
            'utf-8',
        );

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: OPENCODE_TOOL_NAME,
            no_install: true,
            loaded_configuration,
        });
        sandbox_ids.push(manifest.id);

        inject_provider_host_files(manifest.container_name, [{
            host_path: staging_directory,
            container_path: OPENCODE_CONFIG_DIR,
        }], { fail_on_error: true });

        const configuration = exec_container(
            manifest.container_name,
            ['cat', `${OPENCODE_CONFIG_DIR}/opencode.json`],
            { user: 'patchlab' },
        );
        expect(configuration).toContain('home-path-copy-ok');

        fs.rmSync(staging_directory, { recursive: true, force: true });
    }, 120_000);

    it('routes copy_to_container home destinations through the install path', async () => {
        source_directory = make_source_directory();
        const loaded_configuration = load_configuration([source_directory]);

        const host_file = path.join(os.tmpdir(), `patchlab-auth-${Date.now()}.json`);
        fs.writeFileSync(host_file, '{"token":"test"}\n', 'utf-8');

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: OPENCODE_TOOL_NAME,
            no_install: true,
            loaded_configuration,
        });
        sandbox_ids.push(manifest.id);

        copy_to_container(
            manifest.container_name,
            host_file,
            '/home/patchlab/.local/share/opencode/auth.json',
        );

        const auth = exec_container(
            manifest.container_name,
            ['cat', '/home/patchlab/.local/share/opencode/auth.json'],
            { user: 'patchlab' },
        );
        expect(auth).toContain('test');

        fs.unlinkSync(host_file);
    }, 120_000);
});
