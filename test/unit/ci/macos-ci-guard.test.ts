import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

describe('macOS nerdctl CI guardrails (R11)', () => {
    it('does not allow integration-nerdctl to pass with zero tests', () => {
        const config_source = fs.readFileSync(
            path.join(REPOSITORY_ROOT, 'vitest.config.ts'),
            'utf-8',
        );

        const nerdctl_block = config_source.slice(
            config_source.indexOf("name: 'integration-nerdctl'"),
            config_source.indexOf("name: 'posix'"),
        );

        expect(nerdctl_block).not.toContain('passWithNoTests');
    });

    it('requires nerdctl runtime for the integration-nerdctl vitest project', () => {
        const config_source = fs.readFileSync(
            path.join(REPOSITORY_ROOT, 'vitest.config.ts'),
            'utf-8',
        );

        expect(config_source).toContain('PATCHLAB_REQUIRED_CONTAINER_RUNTIME');
        expect(config_source).toContain("PATCHLAB_CONTAINER_RUNTIME: 'nerdctl'");
    });

    it('gives the macOS nerdctl job a timeout and Lima diagnostics upload', () => {
        const workflow = fs.readFileSync(
            path.join(REPOSITORY_ROOT, '.github/workflows/ci.yml'),
            'utf-8',
        );

        const nerdctl_job = workflow.slice(workflow.indexOf('test-macos-nerdctl:'));

        expect(nerdctl_job).toMatch(/timeout-minutes:\s*\d+/);
        expect(nerdctl_job).toMatch(/upload-artifact@v4/);
        expect(nerdctl_job).toMatch(/assert-container-runtime\.mjs nerdctl/);
    });

    it('splits macOS platform tests from the Lima nerdctl integration job', () => {
        const workflow = fs.readFileSync(
            path.join(REPOSITORY_ROOT, '.github/workflows/ci.yml'),
            'utf-8',
        );

        expect(workflow).toContain('test-macos-platform:');
        expect(workflow).toContain('test-macos-nerdctl:');

        const platform_job = workflow.slice(
            workflow.indexOf('test-macos-platform:'),
            workflow.indexOf('test-macos-nerdctl:'),
        );
        expect(platform_job).toMatch(/--project macos/);
        expect(platform_job).not.toContain('integration-nerdctl');
    });
});
