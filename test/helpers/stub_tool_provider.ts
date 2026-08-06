import * as fs from 'node:fs';
import * as path from 'node:path';
import { register_provider } from '../../src/tools/provider.js';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../src/tools/types.js';

export const DEFAULT_TEST_TOOL = 'patchlab-test-tool';
export const FILE_COPY_TEST_TOOL = 'patchlab-test-tool-file-copy';
export const ENV_VAR_TEST_TOOL = 'patchlab-test-tool-env';
export const PREBAKED_TEST_TOOL = 'patchlab-test-tool-prebaked';

/** Matches `image_home` / workspace paths declared by the default integration stub. */
export const TEST_IMAGE_HOME = '/home/node';
export const TEST_CONTAINER_WORKING_DIR = `${TEST_IMAGE_HOME}/workspace`;

/** Per-source YAML mirror of the default TypeScript stub for CLI subprocess tests. */
export const DEFAULT_TEST_TOOL_MANIFEST_YAML = `name: ${DEFAULT_TEST_TOOL}
display_name: Stub ${DEFAULT_TEST_TOOL}
image_user: node
image_home: /home/node
configuration_directory_name: .stub
base_image: node:22-slim
base_family: prebuilt
authentication:
  method: none
launch_command:
  - ${DEFAULT_TEST_TOOL}
dockerfile:
  install:
    - apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
`;

export function write_default_test_tool_manifest(source_directory: string): void {
    const tools_directory = path.join(source_directory, '.patchlab', 'tools');
    fs.mkdirSync(tools_directory, { recursive: true });
    fs.writeFileSync(
        path.join(tools_directory, `${DEFAULT_TEST_TOOL}.yaml`),
        DEFAULT_TEST_TOOL_MANIFEST_YAML,
    );
}

/** Install the default test tool under a redirected HOME for CLI subprocess tests. */
export function write_default_test_tool_manifest_to_home(home_directory: string): void {
    const tools_directory = path.join(home_directory, '.patchlab', 'tools');
    fs.mkdirSync(tools_directory, { recursive: true });
    fs.writeFileSync(
        path.join(tools_directory, `${DEFAULT_TEST_TOOL}.yaml`),
        DEFAULT_TEST_TOOL_MANIFEST_YAML,
    );
}

export function make_stub_tool_provider(
    name: string = DEFAULT_TEST_TOOL,
    overrides: Partial<Tool_Provider> = {},
): Tool_Provider {
    const base: Tool_Provider = {
        name,
        display_name: `Stub ${name}`,
        image_specification: {
            base_image: 'node:22-slim',
            image_user: 'node',
            image_home: '/home/node',
            configuration_directory_name: '.stub',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() {
                return {
                    lines: ['RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*'],
                    package_manager: 'apt' as const,
                };
            },
        },
        inject_authentication(): Authentication_Result { return { type: 'none' }; },
        get_launch_command() { return [name]; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return name; },
        get_authentication_method(): Authentication_Method { return 'none'; },
        get_extractable_artifacts() { return []; },
        async inject_session_state() { /* no-op */ },
    };

    return { ...base, ...overrides, name, display_name: overrides.display_name ?? base.display_name };
}

export function register_default_test_tool(name: string = DEFAULT_TEST_TOOL): Tool_Provider {
    const provider = make_stub_tool_provider(name);
    register_provider(provider);
    return provider;
}

export function register_file_copy_test_tool(name: string = FILE_COPY_TEST_TOOL): Tool_Provider {
    const provider = make_stub_tool_provider(name, {
        get_authentication_method: () => 'file_copy',
        inject_authentication: () => ({ type: 'file_copy' }),
    });
    register_provider(provider);
    return provider;
}

export function register_env_var_test_tool(
    name: string = ENV_VAR_TEST_TOOL,
    variable_name = 'TEST_API_KEY',
): Tool_Provider {
    const provider = make_stub_tool_provider(name, {
        get_authentication_method: () => 'environment_variables',
        inject_authentication: () => {
            const value = process.env[variable_name];
            if (value === undefined || value === '') {
                return { type: 'none' };
            }
            return {
                type: 'environment_variables',
                entries: [{ name: variable_name, value }],
            };
        },
    });
    register_provider(provider);
    return provider;
}

export function register_prebaked_test_tool(
    name: string = PREBAKED_TEST_TOOL,
    base_image = 'prebaked-sandbox:1.0',
): Tool_Provider {
    const provider = make_stub_tool_provider(name, {
        image_specification: {
            base_image,
            image_user: 'node',
            image_home: '/home/node',
            configuration_directory_name: '.stub',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() { return { lines: [] }; },
        },
    });
    register_provider(provider);
    return provider;
}
