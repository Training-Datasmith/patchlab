/**
 * Unit coverage for `ensure_default_image` (src/auto_build.ts) — the auto-build
 * gate that runs on first `patchlab create` when no patchlab-compatible image
 * exists yet. Mocks `./images.js` to control both the "does an image exist?"
 * check and the build step, then exercises each branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';

const { mock_get_default_image, mock_build_image } = vi.hoisted(() => ({
    mock_get_default_image: vi.fn<(required_tool?: string, required_capabilities?: string[]) => string | null>(),
    mock_build_image: vi.fn<(input: { project_directory: string; capabilities: string[]; tools: string[]; base_image?: string }) => Promise<string>>(),
}));

vi.mock('../../src/images.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/images.js')>();
    return {
        ...original,
        get_default_image: mock_get_default_image,
        build_image: mock_build_image,
    };
});

import { ensure_default_image } from '../../src/auto_build.js';

describe('ensure_default_image', () => {
    let project_directory: string;

    beforeEach(() => {
        project_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-ensure-default-')),
        );
        mock_get_default_image.mockReset();
        mock_build_image.mockReset();
        register_default_test_tool();
    });

    afterEach(() => {
        fs.rmSync(project_directory, { recursive: true, force: true });
    });

    it('returns the existing default image tag without invoking the builder', async () => {
        mock_get_default_image.mockReturnValue(`patchlab/${DEFAULT_TEST_TOOL}:abc123`);

        const tag = await ensure_default_image(project_directory, DEFAULT_TEST_TOOL);

        expect(tag).toBe(`patchlab/${DEFAULT_TEST_TOOL}:abc123`);
        expect(mock_build_image).not.toHaveBeenCalled();
        expect(mock_get_default_image).toHaveBeenCalledWith(DEFAULT_TEST_TOOL, [], 'node:22-slim');
    });

    it('builds a new image when no default is present and returns the freshly built tag', async () => {
        mock_get_default_image.mockReturnValue(null);
        mock_build_image.mockResolvedValue(`patchlab/${DEFAULT_TEST_TOOL}:freshly-built`);

        const tag = await ensure_default_image(project_directory, DEFAULT_TEST_TOOL);

        expect(tag).toBe(`patchlab/${DEFAULT_TEST_TOOL}:freshly-built`);
        expect(mock_build_image).toHaveBeenCalledTimes(1);
    });

    it('passes the detected language base image to the builder for a PHP project with a bootstrap provider', async () => {
        fs.writeFileSync(
            path.join(project_directory, 'composer.json'),
            JSON.stringify({ require: { php: '^8.1' } }),
        );
        fs.writeFileSync(
            path.join(project_directory, 'composer.lock'),
            JSON.stringify({ platform: { php: '8.4.0' } }),
        );
        mock_get_default_image.mockReturnValue(null);
        mock_build_image.mockResolvedValue('patchlab/php-8.4-cli:latest');

        const { register_provider } = await import('../../src/tools/index.js');
        register_provider({
            name: 'php-bootstrap-stub',
            display_name: 'PHP bootstrap stub',
            image_specification: {
                base_image: 'php:8.4-cli',
                image_user: 'patchlab',
                image_home: '/home/patchlab',
                configuration_directory_name: '.stub',
                async prepare_build_assets() { return new Map(); },
                get_dockerfile_lines() { return []; },
                get_dockerfile_environment() { return {}; },
                get_base_preparation_lines() {
                    return {
                        lines: ['RUN apt-get update && apt-get install -y git'],
                        package_manager: 'apt' as const,
                    };
                },
            },
            inject_authentication() { return { type: 'none' as const }; },
            get_launch_command() { return ['/bin/sh']; },
            validate_image() { return { valid: true, reasons: [] }; },
            get_cached_version() { return null; },
            get_openspec_tool_name() { return 'php-bootstrap-stub'; },
            get_authentication_method() { return 'none'; },
            get_extractable_artifacts() { return []; },
            async inject_session_state() { /* no-op */ },
        });

        await ensure_default_image(project_directory, 'php-bootstrap-stub');

        const build_arguments = mock_build_image.mock.calls[0][0];
        expect(build_arguments.base_image).toBe('php:8.4-cli');
    });

    it('does not override a pre-baked provider base with language detection', async () => {
        fs.writeFileSync(
            path.join(project_directory, 'package.json'),
            JSON.stringify({ name: 'node-project' }),
        );
        mock_get_default_image.mockReturnValue(null);
        mock_build_image.mockResolvedValue('patchlab/prebaked-sandbox:latest');

        const { register_prebaked_test_tool, PREBAKED_TEST_TOOL } = await import('../helpers/stub_tool_provider.js');
        register_prebaked_test_tool();

        await ensure_default_image(project_directory, PREBAKED_TEST_TOOL);

        const build_arguments = mock_build_image.mock.calls[0][0];
        expect(build_arguments.base_image).toBeUndefined();
    });

    it('passes the requested tool through to the builder and image lookup when one is supplied', async () => {
        mock_get_default_image.mockReturnValue(null);
        mock_build_image.mockResolvedValue(`patchlab/${DEFAULT_TEST_TOOL}:auto`);

        await ensure_default_image(project_directory, DEFAULT_TEST_TOOL);

        const build_arguments = mock_build_image.mock.calls[0][0];
        expect(build_arguments.tools).toEqual([DEFAULT_TEST_TOOL]);
        expect(mock_get_default_image).toHaveBeenCalledWith(DEFAULT_TEST_TOOL, [], 'node:22-slim');
    });

    it('looks up cached images using the detected language base for bootstrap providers', async () => {
        fs.writeFileSync(path.join(project_directory, 'pyproject.toml'), '');

        mock_get_default_image.mockReturnValue('patchlab/python-3.12-slim:latest');

        const tag = await ensure_default_image(project_directory, 'opencode');

        expect(tag).toBe('patchlab/python-3.12-slim:latest');
        expect(mock_get_default_image).toHaveBeenCalledWith('opencode', [], 'python:3.12-slim');
        expect(mock_build_image).not.toHaveBeenCalled();
    });

    it('does not reuse a cached image when lookup is scoped to a different detected base', async () => {
        fs.writeFileSync(path.join(project_directory, 'pyproject.toml'), '');

        mock_get_default_image.mockReturnValue(null);
        mock_build_image.mockResolvedValue('patchlab/python-3.12-slim:latest');

        await ensure_default_image(project_directory, 'opencode');

        expect(mock_get_default_image).toHaveBeenCalledWith('opencode', [], 'python:3.12-slim');
        expect(mock_build_image).toHaveBeenCalledWith(expect.objectContaining({
            base_image: 'python:3.12-slim',
            tools: ['opencode'],
        }));
    });
});
