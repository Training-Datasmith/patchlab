import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detect_openspec } from '../../../src/detect/detectors.js';
import { register_provider } from '../../../src/tools/provider.js';
import type { Authentication_Method, Authentication_Result, Tool_Provider } from '../../../src/tools/types.js';

function make_stub_provider(name: string, openspec_tool_name: string): Tool_Provider {
    return {
        name,
        display_name: `Stub ${name}`,
        image_specification: {
            base_image: 'docker.io/library/node:24-bookworm-slim',
            image_user: 'patchlab',
            image_home: '/home/patchlab',
            configuration_directory_name: '.stub',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() { return { lines: [], package_manager: 'apt' as const }; },
        },
        inject_authentication(): Authentication_Result { return { type: 'none' }; },
        get_launch_command() { return [name]; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return openspec_tool_name; },
        get_authentication_method(): Authentication_Method { return 'none'; },
        get_extractable_artifacts() { return []; },
        async inject_session_state() { /* no-op */ },
    };
}

describe('detect_openspec init_command', () => {
    let temp_directory: string;

    beforeEach(() => {
        temp_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-detect-openspec-'));
        fs.mkdirSync(path.join(temp_directory, 'openspec'), { recursive: true });
        fs.writeFileSync(path.join(temp_directory, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
    });

    afterEach(() => {
        fs.rmSync(temp_directory, { recursive: true, force: true });
    });

    it('omits init_command when the provider openspec tool name is empty', () => {
        register_provider(make_stub_provider('shell-only', ''));
        const requirements = detect_openspec(temp_directory, { tool: 'shell-only' });
        expect(requirements).toHaveLength(1);
        const npm_package = requirements[0];
        expect(npm_package.type).toBe('npm_package');
        if (npm_package.type === 'npm_package') {
            expect(npm_package.init_command).toBeUndefined();
        }
    });

    it('includes init_command when the provider openspec tool name is non-empty', () => {
        register_provider(make_stub_provider('custom-tool', 'custom'));
        const requirements = detect_openspec(temp_directory, { tool: 'custom-tool' });
        expect(requirements[0]).toEqual(expect.objectContaining({
            type: 'npm_package',
            init_command: ['openspec', 'init', '--tools', 'custom'],
        }));
    });
});
