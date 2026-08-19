/**
 * End-to-end coverage for the built-in OpenCode tool provider: real image
 * build, validate_image, sandbox create with `tool: opencode`, and in-container
 * `opencode --version`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox_from_directory } from '../../test_helpers.js';
import { OPENCODE_TOOL_NAME } from '../../../src/opencode/index.js';
import { load_configuration, user_global_configuration_path } from '../../../src/configuration.js';
import {
    build_image,
    PATCHLAB_TEST_LABEL,
    remove_test_images,
    validate_or_remove_image,
} from '../../../src/images.js';
import {
    exec_container,
    get_image_tool_state,
    get_runtime_binary,
    image_exists,
    is_patchlab_compatible_image,
} from '../../../src/container_runtime.js';
import { get_provider } from '../../../src/tools/index.js';
import { PATCHLAB_TOOLS_LABEL } from '../../../src/images.js';
import { inspect_image_labels } from '../../helpers/exec_runtime_cli.js';
import {
    create_integration_cleanup_registry,
    register_destroy_sandbox,
} from '../../helpers/integration_cleanup.js';
const TEST_TAG = 'patchlab/opencode-integration-test:latest';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;
const OPENCODE_IMAGE_HOME = '/home/patchlab';
const OPENCODE_WORKSPACE = `${OPENCODE_IMAGE_HOME}/workspace`;

const cleanup = create_integration_cleanup_registry();

function write_minimal_opencode_configuration(): void {
    const configuration_path = user_global_configuration_path();
    fs.mkdirSync(path.dirname(configuration_path), { recursive: true });
    fs.writeFileSync(
        configuration_path,
        [
            'tool_configuration:',
            '  opencode:',
            '    copy_host_configuration: false',
            '    copy_host_auth: false',
            '    proxy_local_models: false',
            '',
        ].join('\n'),
        'utf-8',
    );
}

function make_source_directory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-opencode-int-'));
    execFileSync('git', ['init'], { cwd: directory });
    fs.writeFileSync(path.join(directory, 'README.md'), '# opencode integration\n');
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
    cleanup.register(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function exec_container_combined_output(container_name: string, command: string[]): string {
    const result = spawnSync(
        get_runtime_binary(),
        ['exec', container_name, ...command],
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

beforeAll(async () => {
    write_minimal_opencode_configuration();
    validate_or_remove_image(TEST_TAG, OPENCODE_TOOL_NAME);
    if (!image_exists(TEST_TAG)) {
        await build_image({
            tag: TEST_TAG,
            tools: [OPENCODE_TOOL_NAME],
            labels: [TEST_LABEL],
        });
    }
}, 600_000);

afterAll(async () => {
    await cleanup.run_all();
    remove_test_images();
});

describe('OpenCode built-in provider — real runtime', () => {
    it('builds a patchlab-compatible image with the opencode tool label', () => {
        expect(is_patchlab_compatible_image(TEST_TAG)).toBe(true);
        expect(get_image_tool_state(TEST_TAG, OPENCODE_TOOL_NAME)).toBe('installed');
        const labels = inspect_image_labels(TEST_TAG);
        expect(labels[PATCHLAB_TOOLS_LABEL]).toContain(OPENCODE_TOOL_NAME);
    });

    it('passes validate_image (opencode --version inside the image)', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        const result = provider.validate_image(TEST_TAG);
        expect(result.valid).toBe(true);
        expect(result.reasons).toEqual([]);
    }, 120_000);

    it('creates a sandbox and runs opencode --version inside the container', async () => {
        const source_directory = make_source_directory();
        const loaded_configuration = load_configuration([source_directory]);
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: OPENCODE_TOOL_NAME,
            no_install: true,
            loaded_configuration,
        });
        register_destroy_sandbox(cleanup, manifest.id);

        const version_output = exec_container(manifest.container_name, ['opencode', '--version']);
        expect(version_output.trim()).toMatch(/\d+\.\d+/);

        const git_output = exec_container(
            manifest.container_name,
            ['git', '-C', OPENCODE_WORKSPACE, 'status', '--porcelain'],
        );
        expect(typeof git_output).toBe('string');
    }, 120_000);

    it('exposes opencode run flags in the installed CLI', async () => {
        const source_directory = make_source_directory();
        const loaded_configuration = load_configuration([source_directory]);
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            tool: OPENCODE_TOOL_NAME,
            no_install: true,
            loaded_configuration,
        });
        register_destroy_sandbox(cleanup, manifest.id);

        const help_output = exec_container_combined_output(
            manifest.container_name,
            ['opencode', 'run', '--help'],
        );
        expect(help_output).toMatch(/\brun\b/);
        expect(help_output).toContain('--auto');
        expect(help_output).toContain('--continue');
        expect(help_output).toContain('--format');
        expect(help_output).toContain('--model');
        expect(help_output).toContain('--agent');
        expect(help_output).toContain('--file');
    }, 120_000);
});
