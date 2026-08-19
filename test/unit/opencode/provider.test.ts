import { describe, it, expect } from 'vitest';
import { get_provider } from '../../../src/tools/index.js';
import { OPENCODE_NPM_SPEC } from '../../../src/opencode/version.js';

describe('OpenCode built-in provider specification', () => {
    const provider = get_provider('opencode');

    it('builds image spec from node:22-slim with opencode install', () => {
        const spec = provider.image_specification;
        expect(spec.base_image).toBe('docker.io/library/node:22-slim');
        expect(spec.image_user).toBe('patchlab');
        expect(spec.get_dockerfile_lines([]).some((line) => line.includes('opencode-ai'))).toBe(true);
    });

    it('bootstraps npm on debian language bases before installing opencode', () => {
        const lines = provider.image_specification.get_dockerfile_lines([]);
        const joined = lines.join('\n');

        expect(joined).toMatch(/command -v npm|nodesource|setup_22/i);
        expect(joined).toContain(OPENCODE_NPM_SPEC);
        expect(joined).not.toContain('opencode-ai@latest');
    });

    it('declares project directory as extractable artifact for resume', () => {
        const artifacts = provider.get_extractable_artifacts();
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0].archive_subpath).toBe('opencode-project');
        expect(artifacts[0].container_path).toContain('.local/share/opencode/project');
    });

    it('maps OpenSpec tool name to opencode', () => {
        expect(provider.get_openspec_tool_name()).toBe('opencode');
    });
});
