import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));
vi.mock('node:fs', async (original) => {
    const actual = await original<typeof import('node:fs')>();
    return {
        ...actual,
        mkdtempSync: vi.fn(() => '/tmp/patchlab-test'),
        copyFileSync: vi.fn(),
        rmSync: vi.fn(),
    };
});
vi.mock('../../src/podman.js', () => ({
    image_exists: vi.fn(() => false),
    CONTAINER_UID: 1000,
}));

import { execFileSync } from 'node:child_process';
import { build_image } from '../../src/images.js';
import type { Authentication_Method } from '../../src/tools/types.js';

function captured_dockerfile(): string {
    const calls = vi.mocked(execFileSync).mock.calls;
    const build_call = calls.find(
        ([_, args]) =>
            Array.isArray(args) &&
            args[0] === 'build',
    );

    if (!build_call) {
        throw new Error('no podman build call captured');
    }

    const options = build_call[2] as { input?: string } | undefined;
    return options?.input ?? '';
}

describe('build_image Dockerfile shape (tasks 6.6.1, 6.6.2, 6.7, 6.8, 4.5.4)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        register_default_test_tool();
    });

    describe('error path: capabilities without package_manager (task 6.6.1)', () => {
        it('throws when capabilities are requested but provider declares no package_manager', async () => {
            // Use the registered `tool-provider-no-pm` stub provider — same mock pattern
            // other tests use to inject a custom Image_Specification.
            const { register_provider } = await import('../../src/tools/index.js');
            register_provider({
                name: 'no-pm-stub',
                display_name: 'No-PM Stub',
                image_specification: {
                    base_image: 'docker.io/library/scratch',
                    image_user: 'patchlab',
                    image_home: '/home/patchlab',
                    configuration_directory_name: '.stub',
                    async prepare_build_assets() { return new Map(); },
                    get_dockerfile_lines() { return []; },
                    get_dockerfile_environment() { return {}; },
                    // package_manager intentionally absent — this is what triggers the error
                    get_base_preparation_lines() { return { lines: [] }; },
                },
                inject_authentication() { return { type: 'none' as const }; },
                get_launch_command() { return ['/bin/sh']; },
                validate_image() { return { valid: true, reasons: [] }; },
                get_cached_version() { return null; },
                get_openspec_tool_name() { return 'no-pm-stub'; },
                get_authentication_method(): Authentication_Method { return 'none'; },
                get_extractable_artifacts() { return []; },
                async inject_session_state() { /* no-op */ },
            });

            await expect(
                build_image({ tools: ['no-pm-stub'], capabilities: ['jq', 'curl'] }),
            ).rejects.toThrow(/no-pm-stub.*package_manager|package_manager.*no-pm-stub/i);

            // Verify the error message mentions the requested capabilities so the user
            // can identify what was rejected.
            await expect(
                build_image({ tools: ['no-pm-stub'], capabilities: ['jq', 'curl'] }),
            ).rejects.toThrow(/jq.*curl|curl.*jq|jq, curl|curl, jq/);
        });
    });

    describe('stub-provider capability regression (task 6.6.2)', () => {
        it('renders an apt-get install for --capability jq against the stub provider', async () => {
            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            await build_image({ tools: [DEFAULT_TEST_TOOL], capabilities: ['jq'] });
            const dockerfile = captured_dockerfile();
            expect(dockerfile).toContain('apt-get');
            expect(dockerfile).toContain('install');
            expect(dockerfile).toContain('jq');
            expect(dockerfile).toMatch(/FROM node:22-slim[\s\S]*USER root[\s\S]*apt-get/s);
            expect(dockerfile).toContain('biz.ecartz.patchlab.package_manager="apt"');
        });
    });

    describe('mock-driven Dockerfile assembly (task 6.7)', () => {
        it('renders base_preparation.lines, capabilities install, and package_manager LABEL when set', async () => {
            const { register_provider } = await import('../../src/tools/index.js');
            register_provider({
                name: 'mock-with-pm',
                display_name: 'Mock with PM',
                image_specification: {
                    base_image: 'docker.io/library/test:latest',
                    image_user: 'patchlab',
                    image_home: '/home/patchlab',
                    configuration_directory_name: '.mock',
                    async prepare_build_assets() { return new Map(); },
                    get_dockerfile_lines() { return []; },
                    get_dockerfile_environment() { return {}; },
                    get_base_preparation_lines() { return { lines: ['RUN echo fake-prep'], package_manager: 'apt' as const }; },
                },
                inject_authentication() { return { type: 'none' as const }; },
                get_launch_command() { return ['/bin/sh']; },
                validate_image() { return { valid: true, reasons: [] }; },
                get_cached_version() { return null; },
                get_openspec_tool_name() { return 'mock-with-pm'; },
                get_authentication_method(): Authentication_Method { return 'none'; },
                get_extractable_artifacts() { return []; },
                async inject_session_state() { /* no-op */ },
            });

            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            await build_image({ tools: ['mock-with-pm'], capabilities: ['jq'] });
            const dockerfile = captured_dockerfile();
            expect(dockerfile).toContain('RUN echo fake-prep');
            expect(dockerfile).toContain('biz.ecartz.patchlab.package_manager="apt"');
            expect(dockerfile).toMatch(/apt-get update.*install.*jq/s);
        });

        it('skips capabilities install AND package_manager LABEL when package_manager is unset', async () => {
            const { register_provider } = await import('../../src/tools/index.js');
            register_provider({
                name: 'mock-no-pm',
                display_name: 'Mock no PM',
                image_specification: {
                    base_image: 'docker.io/library/test:latest',
                    image_user: 'patchlab',
                    image_home: '/home/patchlab',
                    configuration_directory_name: '.mock',
                    async prepare_build_assets() { return new Map(); },
                    get_dockerfile_lines() { return []; },
                    get_dockerfile_environment() { return {}; },
                    get_base_preparation_lines() { return { lines: [] }; },
                },
                inject_authentication() { return { type: 'none' as const }; },
                get_launch_command() { return ['/bin/sh']; },
                validate_image() { return { valid: true, reasons: [] }; },
                get_cached_version() { return null; },
                get_openspec_tool_name() { return 'mock-no-pm'; },
                get_authentication_method(): Authentication_Method { return 'none'; },
                get_extractable_artifacts() { return []; },
                async inject_session_state() { /* no-op */ },
            });

            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            // No capabilities → no error, no package_manager LABEL.
            await build_image({ tools: ['mock-no-pm'] });
            const dockerfile = captured_dockerfile();
            expect(dockerfile).not.toContain('biz.ecartz.patchlab.package_manager');
            expect(dockerfile).not.toContain('apt-get');
        });

        it('double-quotes ENV values so spaces / quotes do not break the build', async () => {
            const { register_provider } = await import('../../src/tools/index.js');
            register_provider({
                name: 'mock-env-quoting',
                display_name: 'Mock ENV quoting',
                image_specification: {
                    base_image: 'docker.io/library/test:latest',
                    image_user: 'patchlab',
                    image_home: '/home/patchlab',
                    configuration_directory_name: '.mock',
                    async prepare_build_assets() { return new Map(); },
                    get_dockerfile_lines() { return []; },
                    get_dockerfile_environment() {
                        return {
                            GREETING: 'hello world',
                            QUOTED: 'say "hi"',
                        };
                    },
                    get_base_preparation_lines() { return { lines: [] }; },
                },
                inject_authentication() { return { type: 'none' as const }; },
                get_launch_command() { return ['/bin/sh']; },
                validate_image() { return { valid: true, reasons: [] }; },
                get_cached_version() { return null; },
                get_openspec_tool_name() { return 'mock-env-quoting'; },
                get_authentication_method(): Authentication_Method { return 'none'; },
                get_extractable_artifacts() { return []; },
                async inject_session_state() { /* no-op */ },
            });

            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            await build_image({ tools: ['mock-env-quoting'] });
            const dockerfile = captured_dockerfile();
            // A space-containing value must be quoted (a bare `ENV GREETING=hello world`
            // would make Dockerfile parse `world` as a second key=value and fail).
            expect(dockerfile).toContain('ENV GREETING="hello world"');
            // Embedded double-quotes are escaped.
            expect(dockerfile).toContain('ENV QUOTED="say \\"hi\\""');
        });
    });

    describe('detect_project is no longer consulted (task 6.8)', () => {
        it('uses provider.image_specification.base_image even when project_directory points at a Python marker', async () => {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const os = await import('node:os');
            const project_directory = path.join(os.tmpdir(), `patchlab-test-${Date.now()}`);
            const actual_fs = await vi.importActual<typeof import('node:fs')>('node:fs');
            actual_fs.mkdirSync(project_directory, { recursive: true });
            actual_fs.writeFileSync(path.join(project_directory, 'pyproject.toml'), '[project]\nname="test"\n');

            try {
                vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
                await build_image({ tools: [DEFAULT_TEST_TOOL], project_directory });
                const dockerfile = captured_dockerfile();
                expect(dockerfile).toContain('FROM node:22-slim');
                expect(dockerfile).not.toContain('python');
            } finally {
                actual_fs.rmSync(project_directory, { recursive: true, force: true });
            }
        });

        it('honors --base override regardless of provider.image_specification.base_image', async () => {
            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            await build_image({ tools: [DEFAULT_TEST_TOOL], base_image: 'python:3.12-slim' });
            const dockerfile = captured_dockerfile();
            expect(dockerfile).toContain('FROM python:3.12-slim');
        });
    });

    describe('alpine + --capability (task 4.5.4)', () => {
        it('renders an apk add command when an alpine-family provider is used with capabilities', async () => {
            const { register_provider } = await import('../../src/tools/index.js');
            register_provider({
                name: 'mock-alpine',
                display_name: 'Mock alpine',
                image_specification: {
                    base_image: 'docker.io/library/alpine:3.19',
                    image_user: 'patchlab',
                    image_home: '/home/patchlab',
                    configuration_directory_name: '.mock',
                    async prepare_build_assets() { return new Map(); },
                    get_dockerfile_lines() { return []; },
                    get_dockerfile_environment() { return {}; },
                    get_base_preparation_lines() {
                        return {
                            lines: ['RUN apk add --no-cache git'],
                            package_manager: 'apk' as const,
                        };
                    },
                },
                inject_authentication() { return { type: 'none' as const }; },
                get_launch_command() { return ['/bin/sh']; },
                validate_image() { return { valid: true, reasons: [] }; },
                get_cached_version() { return null; },
                get_openspec_tool_name() { return 'mock-alpine'; },
                get_authentication_method(): Authentication_Method { return 'none'; },
                get_extractable_artifacts() { return []; },
                async inject_session_state() { /* no-op */ },
            });

            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            await build_image({ tools: ['mock-alpine'], capabilities: ['jq'] });
            const dockerfile = captured_dockerfile();
            expect(dockerfile).toContain('apk add --no-cache jq');
            expect(dockerfile).toContain('biz.ecartz.patchlab.package_manager="apk"');
        });
    });
});