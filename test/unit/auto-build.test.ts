import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';

vi.mock('../../src/images.js', () => ({
    get_default_image: vi.fn(),
    build_image: vi.fn(),
}));

vi.mock('../../src/detect/index.js', () => ({
    detect_requirements: vi.fn(),
}));

vi.mock('../../src/overrides.js', () => ({
    load_overrides: vi.fn(),
}));

vi.mock('../../src/overrides_merge.js', () => ({
    merge_requirements: vi.fn(),
}));

import { ensure_default_image } from '../../src/auto_build.js';
import { get_default_image, build_image } from '../../src/images.js';
import { detect_requirements } from '../../src/detect/index.js';
import { load_overrides } from '../../src/overrides.js';
import { merge_requirements } from '../../src/overrides_merge.js';

const mock_get_default_image = vi.mocked(get_default_image);
const mock_build_image = vi.mocked(build_image);
const mock_detect_requirements = vi.mocked(detect_requirements);
const mock_load_overrides = vi.mocked(load_overrides);
const mock_merge_requirements = vi.mocked(merge_requirements);

describe('ensure_default_image', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        register_default_test_tool();
    });

    it('returns existing image when one is available without rebuilding', async () => {
        mock_get_default_image.mockReturnValue('patchlab/node-22-slim:latest');
        mock_detect_requirements.mockReturnValue({
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_load_overrides.mockReturnValue({});
        mock_merge_requirements.mockReturnValue({
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });

        const result = await ensure_default_image('/some/project', DEFAULT_TEST_TOOL);

        expect(result).toBe('patchlab/node-22-slim:latest');
        expect(mock_build_image).not.toHaveBeenCalled();
        expect(mock_get_default_image).toHaveBeenCalledWith(DEFAULT_TEST_TOOL, []);
    });

    it('auto-builds when no compatible image exists', async () => {
        mock_get_default_image.mockReturnValue(null);
        mock_detect_requirements.mockReturnValue({
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_load_overrides.mockReturnValue({});
        mock_merge_requirements.mockReturnValue({
            system_packages: [{ type: 'system_package', capability: 'curl', source: 'ci_configuration' }],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_build_image.mockResolvedValue('patchlab/node-22-slim:latest');

        const result = await ensure_default_image('/some/project', DEFAULT_TEST_TOOL);

        expect(result).toBe('patchlab/node-22-slim:latest');
        expect(mock_build_image).toHaveBeenCalledWith({
            project_directory: '/some/project',
            capabilities: ['curl'],
            tools: [DEFAULT_TEST_TOOL],
        });
    });

    it('passes detected capabilities through to build_image', async () => {
        mock_get_default_image.mockReturnValue(null);
        mock_detect_requirements.mockReturnValue({
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_load_overrides.mockReturnValue({});
        mock_merge_requirements.mockReturnValue({
            system_packages: [
                { type: 'system_package', capability: 'postgres-client', source: 'ci_configuration' },
                { type: 'system_package', capability: 'redis-tools', source: 'test_scripts' },
            ],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_build_image.mockResolvedValue('patchlab/node-22-slim:latest');

        await ensure_default_image('/some/project', DEFAULT_TEST_TOOL);

        expect(mock_build_image).toHaveBeenCalledWith({
            project_directory: '/some/project',
            capabilities: ['postgres-client', 'redis-tools'],
            tools: [DEFAULT_TEST_TOOL],
        });
    });

    it('passes tool name through to detect_requirements, get_default_image, and build_image', async () => {
        mock_get_default_image.mockReturnValue(null);
        mock_detect_requirements.mockReturnValue({
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_load_overrides.mockReturnValue({});
        mock_merge_requirements.mockReturnValue({
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services: [],
            npm_packages: [],
        });
        mock_build_image.mockResolvedValue('patchlab/sandbox:latest');

        await ensure_default_image('/some/project', DEFAULT_TEST_TOOL);

        expect(mock_detect_requirements).toHaveBeenCalledWith(
            '/some/project',
            { tool: DEFAULT_TEST_TOOL },
        );
        expect(mock_get_default_image).toHaveBeenCalledWith(DEFAULT_TEST_TOOL, []);
        expect(mock_build_image).toHaveBeenCalledWith({
            project_directory: '/some/project',
            capabilities: [],
            tools: [DEFAULT_TEST_TOOL],
        });
    });
});
