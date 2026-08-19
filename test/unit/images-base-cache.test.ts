import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { OPENCODE_TOOL_NAME } from '../../src/tools/index.js';
import { register_default_test_tool } from '../helpers/stub_tool_provider.js';
import { mock_spawn_sync_result } from '../helpers/spawn_sync_mock.js';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawnSync: vi.fn(),
}));

vi.mock('../../src/container_runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/container_runtime.js')>();
    return {
        ...actual,
        image_exists: vi.fn(() => true),
    };
});

import {
    get_default_image,
    patchlab_image_repository_for_base,
} from '../../src/images.js';
import { image_exists } from '../../src/container_runtime.js';

const mock_image_exists = vi.mocked(image_exists);

function mock_images(images: {
    repository: string;
    tag?: string;
    tools: string;
    capabilities?: string;
}[]): void {
    vi.mocked(execFileSync).mockImplementation((_command, args) => {
        const argv = args as string[];
        if (argv.includes('images')) {
            return Buffer.from(JSON.stringify(images.map((image) => ({
                Names: [`${image.repository}:${image.tag ?? 'latest'}`],
                Labels: {
                    'biz.ecartz.patchlab.compatible': 'true',
                    'biz.ecartz.patchlab.tools': image.tools,
                    'biz.ecartz.patchlab.capabilities': image.capabilities ?? '',
                },
                Id: 'abc123def456789012',
            }))));
        }
        if (argv.includes('git') && argv.includes('--version')) {
            return Buffer.from('');
        }
        if (argv.includes('opencode') && argv.includes('--version')) {
            return Buffer.from('1.18.18\n');
        }
        if (argv.includes('opencode') && argv.includes('export') && argv.includes('--help')) {
            return Buffer.from('  --sanitize\n');
        }
        return Buffer.from('');
    });

    vi.mocked(spawnSync).mockImplementation((_command, args) => {
        const argv = args as string[];
        if (argv.includes('git') && argv.includes('--version')) {
            return mock_spawn_sync_result();
        }
        if (argv.includes('opencode') && argv.includes('--version')) {
            return mock_spawn_sync_result({ stdout: '1.18.18\n' });
        }
        if (argv.includes('opencode') && argv.includes('export') && argv.includes('--help')) {
            return mock_spawn_sync_result({ stdout: '  --sanitize\n' });
        }
        return mock_spawn_sync_result();
    });
}

describe('get_default_image base-image cache matching', () => {
    beforeEach(() => {
        mock_image_exists.mockReturnValue(true);
        register_default_test_tool();
    });

    it('derives the patchlab repository name the same way build_image tags bases', () => {
        expect(patchlab_image_repository_for_base('python:3.12-slim'))
            .toBe('patchlab/python-3.12-slim');
        expect(patchlab_image_repository_for_base('docker.io/library/node:22-slim'))
            .toBe('patchlab/docker.io/library/node-22-slim');
    });

    it('returns the cached image whose repository matches the required base', () => {
        mock_images([
            {
                repository: 'patchlab/node-22-slim',
                tools: OPENCODE_TOOL_NAME,
            },
            {
                repository: 'patchlab/python-3.12-slim',
                tools: OPENCODE_TOOL_NAME,
            },
        ]);

        expect(get_default_image(OPENCODE_TOOL_NAME, [], 'python:3.12-slim'))
            .toBe('patchlab/python-3.12-slim:latest');
    });

    it('returns null when only a different-language cached image exists', () => {
        mock_images([
            {
                repository: 'patchlab/node-22-slim',
                tools: OPENCODE_TOOL_NAME,
            },
        ]);

        expect(get_default_image(OPENCODE_TOOL_NAME, [], 'python:3.12-slim')).toBeNull();
    });
});
