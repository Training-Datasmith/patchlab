// list_images / get_default_image / has_any_compatible_image parse podman's
// JSON output. The producer step (execFileSync('podman', ['images', ...])) is
// mocked here so these tests are deterministic and never call real podman.
// Integration coverage for the actual podman round-trip lives in
// test/integration/podman/sandbox-podman.test.ts (image listing functions describe).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
    DEFAULT_TEST_TOOL,
    ENV_VAR_TEST_TOOL,
    PREBAKED_TEST_TOOL,
    register_default_test_tool,
    register_env_var_test_tool,
    register_prebaked_test_tool,
} from '../helpers/stub_tool_provider.js';

const MOCK_IMAGE_NAMES = ['patchlab/mock-image:latest'];
const MOCK_IMAGE_JSON = JSON.stringify([
    {
        Names: MOCK_IMAGE_NAMES,
        Labels: {
            'biz.ecartz.patchlab.compatible': 'true',
            'biz.ecartz.patchlab.tools': `${DEFAULT_TEST_TOOL},${ENV_VAR_TEST_TOOL}`,
            'biz.ecartz.patchlab.capabilities': 'php,composer',
        },
        Id: 'abc123def456789012',
    },
]);

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(() => Buffer.from(MOCK_IMAGE_JSON)),
}));

vi.mock('../../src/container_runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/container_runtime.js')>();
    return {
        ...actual,
        image_exists: vi.fn(() => true),
    };
});

import { list_images, get_default_image, has_any_compatible_image, validate_image, PATCHLAB_LABEL, PATCHLAB_TOOLS_LABEL, CAPABILITIES_LABEL } from '../../src/images.js';
import * as images from '../../src/images.js';
import { image_exists } from '../../src/container_runtime.js';

const mock_image_exists = vi.mocked(image_exists);

describe('image management', () => {
    beforeEach(() => {
        vi.mocked(execFileSync).mockReturnValue(Buffer.from(MOCK_IMAGE_JSON));
        mock_image_exists.mockReturnValue(true);
        register_default_test_tool();
        register_env_var_test_tool();
        register_prebaked_test_tool();
    });

    describe('list_images', () => {
        it('parses repository and tag from Names array', () => {
            const images = list_images();
            expect(images).toHaveLength(1);
            expect(images[0].repository).toBe('patchlab/mock-image');
            expect(images[0].tag).toBe('latest');
        });

        it('parses tools from the tools label', () => {
            const images = list_images();
            expect(images[0].tools).toEqual([DEFAULT_TEST_TOOL, ENV_VAR_TEST_TOOL]);
        });

        it('parses capabilities from the capabilities label', () => {
            const images = list_images();
            expect(images[0].capabilities).toEqual(['php', 'composer']);
        });

        it('strips localhost/ prefix from repository names', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(JSON.stringify([{
                Names: ['localhost/patchlab/local-image:latest'],
                Labels: { 'biz.ecartz.patchlab.compatible': 'true', 'biz.ecartz.patchlab.tools': DEFAULT_TEST_TOOL },
                Id: '112233445566',
            }])));
            const images = list_images();
            expect(images[0].repository).toBe('patchlab/local-image');
            expect(images[0].tag).toBe('latest');
        });

        it('returns empty capabilities when the capabilities label is absent', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(JSON.stringify([{
                Names: ['patchlab/no-caps:latest'],
                Labels: { 'biz.ecartz.patchlab.compatible': 'true', 'biz.ecartz.patchlab.tools': DEFAULT_TEST_TOOL },
                Id: 'aabbccddeeff',
            }])));
            const images = list_images();
            expect(images[0].capabilities).toEqual([]);
        });

        it('truncates image id to 12 characters', () => {
            const images = list_images();
            expect(images[0].id).toBe('abc123def456');
        });

        it('returns empty array when podman exits with an error', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('podman not running'); });
            expect(list_images()).toEqual([]);
        });

        it('returns empty array when podman returns empty JSON array', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from('[]'));
            expect(list_images()).toEqual([]);
        });
    });

    describe('get_default_image', () => {
        it('returns repository:tag of the first fit image when no filters are given', () => {
            vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
                const argv = args as string[];
                if (argv.includes('images')) {
                    return Buffer.from(MOCK_IMAGE_JSON);
                }
                if (argv.includes('git') && argv.includes('--version')) {
                    return Buffer.from('');
                }
                return Buffer.from('');
            });
            expect(get_default_image()).toBe('patchlab/mock-image:latest');
        });

        it('returns the image when the required tool is present', () => {
            expect(get_default_image(DEFAULT_TEST_TOOL)).toBe('patchlab/mock-image:latest');
        });

        it('returns a pre-baked-provider image when the repository matches the provider base', async () => {
            const prebaked_base = 'prebaked-sandbox:1.0';
            const prebaked_images = JSON.stringify([{
                Names: [`patchlab/prebaked-sandbox-1.0-${PREBAKED_TEST_TOOL}-auth:latest`],
                Labels: {
                    'biz.ecartz.patchlab.compatible': 'true',
                    'biz.ecartz.patchlab.tools': PREBAKED_TEST_TOOL,
                    'biz.ecartz.patchlab.capabilities': 'podman',
                },
                Id: 'abc123def456789012',
            }]);
            vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
                const argv = args as string[];
                if (argv.includes('images')) {
                    return Buffer.from(prebaked_images);
                }
                if (argv.includes('git') && argv.includes('--version')) {
                    return Buffer.from('');
                }
                return Buffer.from('');
            });
            expect(get_default_image(PREBAKED_TEST_TOOL, ['podman']))
                .toBe(`patchlab/prebaked-sandbox-1.0-${PREBAKED_TEST_TOOL}-auth:latest`);
        });

        it('ignores generic language-detection images for a pre-baked provider', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from(JSON.stringify([
                {
                    Names: ['patchlab/node-22-slim:latest'],
                    Labels: {
                        'biz.ecartz.patchlab.compatible': 'true',
                        'biz.ecartz.patchlab.tools': PREBAKED_TEST_TOOL,
                        'biz.ecartz.patchlab.capabilities': 'podman',
                    },
                    Id: 'abc123def456789012',
                },
            ])));
            expect(get_default_image(PREBAKED_TEST_TOOL, ['podman'])).toBeNull();
        });

        it('returns null when the required tool is not present in any image', () => {
            expect(get_default_image('unknown-tool')).toBeNull();
        });

        it('returns the image when required capabilities are a subset of image capabilities', async () => {
            const env_var_images = JSON.stringify([{
                Names: [`patchlab/prebaked-sandbox-1.0-${ENV_VAR_TEST_TOOL}-auth:latest`],
                Labels: {
                    'biz.ecartz.patchlab.compatible': 'true',
                    'biz.ecartz.patchlab.tools': ENV_VAR_TEST_TOOL,
                    'biz.ecartz.patchlab.capabilities': 'php,composer',
                },
                Id: 'abc123def456789012',
            }]);
            vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
                const argv = args as string[];
                if (argv.includes('images')) {
                    return Buffer.from(env_var_images);
                }
                if (argv.includes('git') && argv.includes('--version')) {
                    return Buffer.from('');
                }
                return Buffer.from('');
            });
            expect(get_default_image(ENV_VAR_TEST_TOOL, ['php'])).toBe(
                `patchlab/prebaked-sandbox-1.0-${ENV_VAR_TEST_TOOL}-auth:latest`,
            );
        });

        it('returns null when an image lacks a required capability', () => {
            expect(get_default_image(DEFAULT_TEST_TOOL, ['php', 'redis-tools'])).toBeNull();
        });

        it('returns null when no images exist', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from('[]'));
            expect(get_default_image()).toBeNull();
        });

        it('skips label-matching images that fail validate_image and tries the next candidate', async () => {
            const invalid_tag = `patchlab/prebaked-sandbox-1.0-${PREBAKED_TEST_TOOL}:latest`;
            const valid_tag = `patchlab/prebaked-sandbox-1.0-${PREBAKED_TEST_TOOL}-auth:latest`;
            const prebaked_images = JSON.stringify([
                {
                    Names: [invalid_tag],
                    Labels: {
                        'biz.ecartz.patchlab.compatible': 'true',
                        'biz.ecartz.patchlab.tools': PREBAKED_TEST_TOOL,
                        'biz.ecartz.patchlab.capabilities': 'podman',
                    },
                    Id: 'abc123def456789012',
                },
                {
                    Names: [valid_tag],
                    Labels: {
                        'biz.ecartz.patchlab.compatible': 'true',
                        'biz.ecartz.patchlab.tools': PREBAKED_TEST_TOOL,
                        'biz.ecartz.patchlab.capabilities': 'podman',
                    },
                    Id: 'def456abc789012',
                },
            ]);

            vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
                const argv = args as string[];
                if (argv.includes('images')) {
                    return Buffer.from(prebaked_images);
                }
                const tag = argv.find((argument) => argument.startsWith('patchlab/'));
                if (argv.includes('git') && argv.includes('--version') && tag === invalid_tag) {
                    throw new Error('git not found');
                }
                return Buffer.from('');
            });

            expect(get_default_image(PREBAKED_TEST_TOOL, ['podman'])).toBe(valid_tag);
        });
    });

    describe('validate_image', () => {
        beforeEach(() => {
            vi.restoreAllMocks();
            vi.mocked(execFileSync).mockReturnValue(Buffer.from(MOCK_IMAGE_JSON));
            mock_image_exists.mockReturnValue(true);
        });

        it('returns invalid when git is missing even if the provider binary check passes', async () => {
            const { get_provider } = await import('../../src/tools/index.js');
            vi.spyOn(get_provider(DEFAULT_TEST_TOOL), 'validate_image').mockReturnValue({
                valid: true,
                reasons: [],
            });

            vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
                const argv = args as string[];
                if (argv.includes('git') && argv.includes('--version')) {
                    throw new Error('git not found');
                }
                return Buffer.from('');
            });

            const result = validate_image('patchlab/fixture:latest', DEFAULT_TEST_TOOL);
            expect(result.valid).toBe(false);
            expect(result.reasons).toContain('git binary not found in $PATH');
        });

        it('aggregates git and provider failures', async () => {
            const { get_provider } = await import('../../src/tools/index.js');
            vi.spyOn(get_provider(DEFAULT_TEST_TOOL), 'validate_image').mockReturnValue({
                valid: false,
                reasons: ['stub binary not found or not executable'],
            });

            vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
                const argv = args as string[];
                if (argv.includes('git') && argv.includes('--version')) {
                    throw new Error('git not found');
                }
                return Buffer.from('');
            });

            const result = validate_image('patchlab/fixture:latest', DEFAULT_TEST_TOOL);
            expect(result.valid).toBe(false);
            expect(result.reasons).toContain('git binary not found in $PATH');
            expect(result.reasons).toContain('stub binary not found or not executable');
        });
    });

    describe('has_any_compatible_image', () => {
        it('returns true when list_images is non-empty', () => {
            expect(has_any_compatible_image()).toBe(true);
        });

        it('returns false when no images exist', async () => {
            const { execFileSync } = await import('node:child_process');
            vi.mocked(execFileSync).mockReturnValueOnce(Buffer.from('[]'));
            expect(has_any_compatible_image()).toBe(false);
        });
    });

    describe('labels', () => {
        it('exports expected label constants', () => {
            expect(PATCHLAB_LABEL).toBe('biz.ecartz.patchlab.compatible');
            expect(PATCHLAB_TOOLS_LABEL).toBe('biz.ecartz.patchlab.tools');
            expect(CAPABILITIES_LABEL).toBe('biz.ecartz.patchlab.capabilities');
        });
    });

    describe('build_image validation', () => {
        it('rejects unknown tools', async () => {
            const { build_image } = await import('../../src/images.js');
            await expect(build_image({ tools: ['nonexistent-tool'] })).rejects.toThrow(/Unknown tool/);
        });
    });
});
