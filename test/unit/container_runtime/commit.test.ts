import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

import type { Container_Runtime_Kind } from '../../../src/container_runtime/types.js';

const exec_runtime_mock = vi.fn();
const get_container_runtime_mock = vi.fn((): { kind: Container_Runtime_Kind; binary: string } => ({
    kind: 'podman',
    binary: 'podman',
}));

vi.mock('../../../src/container_runtime/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/container_runtime/registry.js')>();
    return {
        ...actual,
        exec_runtime: (...args: Parameters<typeof actual.exec_runtime>) => exec_runtime_mock(...args),
        get_container_runtime: () => get_container_runtime_mock(),
    };
});

import { commit_container } from '../../../src/container_runtime/index.js';

describe('commit_container', () => {
    beforeEach(() => {
        exec_runtime_mock.mockReset();
        get_container_runtime_mock.mockReturnValue({ kind: 'podman', binary: 'podman' });
    });

    it('commits without flags when no labels are supplied', () => {
        commit_container('sandbox', 'patchlab/test:latest');
        expect(exec_runtime_mock).toHaveBeenCalledWith(
            ['commit', 'sandbox', 'patchlab/test:latest'],
            { stdio: 'pipe' },
        );
    });

    it('uses podman -c LABEL directives when labels are supplied', () => {
        commit_container('sandbox', 'patchlab/test:latest', {
            'biz.ecartz.patchlab.compatible': 'true',
            'biz.ecartz.patchlab.tools': 'a,b',
        });
        expect(exec_runtime_mock).toHaveBeenCalledWith(
            [
                'commit',
                '-c', 'LABEL biz.ecartz.patchlab.compatible="true"',
                '-c', 'LABEL biz.ecartz.patchlab.tools="a,b"',
                'sandbox',
                'patchlab/test:latest',
            ],
            { stdio: 'pipe' },
        );
    });

    it('stages and rebuilds on nerdctl because -c LABEL is unsupported', () => {
        get_container_runtime_mock.mockReturnValue({ kind: 'nerdctl', binary: 'nerdctl.lima' });

        let captured_dockerfile: string | null = null;
        exec_runtime_mock.mockImplementation((args: string[]) => {
            if (args[0] === 'build') {
                const flag_index = args.indexOf('-f');
                const dockerfile_path = args[flag_index + 1];
                captured_dockerfile = fs.readFileSync(dockerfile_path, 'utf-8');
            }

            return Buffer.from('');
        });

        commit_container('sandbox', 'patchlab/test:latest', {
            'biz.ecartz.patchlab.compatible': 'true',
        });

        expect(exec_runtime_mock).toHaveBeenCalledTimes(3);
        const staging_tag = String(exec_runtime_mock.mock.calls[0][0][2]);
        expect(exec_runtime_mock.mock.calls[0][0]).toEqual(['commit', 'sandbox', staging_tag]);
        expect(staging_tag).toMatch(/^patchlab\/commit-staging:/);

        const build_args = exec_runtime_mock.mock.calls[1][0] as string[];
        expect(build_args[0]).toBe('build');
        expect(build_args).toContain('-t');
        expect(build_args).toContain('patchlab/test:latest');
        const flag_index = build_args.indexOf('-f');
        expect(flag_index).toBeGreaterThanOrEqual(0);
        expect(build_args[flag_index + 1]).toMatch(/Dockerfile$/);
        expect(build_args.at(-1)).toBe(build_args[flag_index + 2]);
        const build_options = exec_runtime_mock.mock.calls[1][1] as { input?: string } | undefined;
        expect(build_options?.input).toBeUndefined();
        expect(captured_dockerfile).toContain(`FROM ${staging_tag}`);
        expect(captured_dockerfile).toContain('LABEL biz.ecartz.patchlab.compatible="true"');

        expect(exec_runtime_mock.mock.calls[2][0]).toEqual(['rmi', '-f', staging_tag]);
    });
});
