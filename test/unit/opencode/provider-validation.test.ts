import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { get_provider } from '../../../src/tools/index.js';
import {
    OPENCODE_PINNED_VERSION,
    OPENCODE_NPM_SPEC,
    parse_opencode_version_output,
} from '../../../src/opencode/version.js';
import { opencode_manifest_hash_inputs } from '../../../src/opencode/provider.js';
import { compute_manifest_hash } from '../../../src/tools/configured_provider/trust_hash.js';
import { mock_spawn_sync_result } from '../../helpers/spawn_sync_mock.js';

vi.mock('node:child_process', () => ({
    spawnSync: vi.fn(),
}));

import { get_runtime_binary } from '../../../src/container_runtime.js';

const provider = get_provider('opencode');

function mock_container_command(handler: (command: string[]) => string | Error): void {
    vi.mocked(spawnSync).mockImplementation((_binary, args) => {
        const argv = args as string[];
        if (argv[0] !== 'run') {
            return mock_spawn_sync_result();
        }
        const network_index = argv.indexOf('--network');
        const image_tag_index = network_index + 2;
        const command = argv.slice(image_tag_index + 1);
        const result = handler(command);
        if (result instanceof Error) {
            return mock_spawn_sync_result({ status: 1, stderr: result.message });
        }
        return mock_spawn_sync_result({ stdout: result });
    });
}

describe('OpenCode pinned toolchain (R10)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('installs a pinned npm spec instead of @latest', () => {
        const lines = provider.image_specification.get_dockerfile_lines([]);
        const joined = lines.join('\n');

        expect(joined).toContain(OPENCODE_NPM_SPEC);
        expect(joined).not.toContain('opencode-ai@latest');
    });

    it('exposes the pinned version through get_cached_version', () => {
        expect(provider.get_cached_version()).toBe(OPENCODE_PINNED_VERSION);
    });

    it('includes the install spec in manifest hash inputs so spec changes invalidate labels', () => {
        const hash = compute_manifest_hash(opencode_manifest_hash_inputs());
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        expect(opencode_manifest_hash_inputs().dockerfile?.install?.[0]).toContain(OPENCODE_NPM_SPEC);
    });

    it('parses semver output from opencode --version', () => {
        expect(parse_opencode_version_output('1.18.18\n')).toBe('1.18.18');
        expect(parse_opencode_version_output('opencode version 1.2.3\n')).toBe('1.2.3');
        expect(parse_opencode_version_output('')).toBeNull();
    });

    it('validate_image rejects images whose opencode version does not match the pin', () => {
        mock_container_command((command) => {
            if (command.join(' ') === 'opencode --version') {
                return '0.9.0\n';
            }
            if (command.join(' ') === 'opencode export --help') {
                return '  --sanitize\n';
            }
            return '';
        });

        const result = provider.validate_image('patchlab/opencode:stale');
        expect(result.valid).toBe(false);
        expect(result.reasons.join('; ')).toMatch(/does not match pinned/i);
    });

    it('validate_image rejects images whose export subcommand lacks --sanitize', () => {
        mock_container_command((command) => {
            if (command.join(' ') === 'opencode --version') {
                return `${OPENCODE_PINNED_VERSION}\n`;
            }
            if (command.join(' ') === 'opencode export --help') {
                return '  --format json\n';
            }
            return '';
        });

        const result = provider.validate_image('patchlab/opencode:old-export');
        expect(result.valid).toBe(false);
        expect(result.reasons.join('; ')).toMatch(/--sanitize/i);
    });

    it('validate_image accepts images matching the pin with export --sanitize support', () => {
        mock_container_command((command) => {
            if (command.join(' ') === 'opencode --version') {
                return `${OPENCODE_PINNED_VERSION}\n`;
            }
            if (command.join(' ') === 'opencode export --help') {
                return '  --sanitize  Sanitize exported session JSON\n';
            }
            return '';
        });

        const result = provider.validate_image('patchlab/opencode:good');
        expect(result).toEqual({ valid: true, reasons: [] });
        expect(get_runtime_binary).toBeDefined();
    });

    it('validate_image reads export --help from stderr when the CLI prints help there', () => {
        vi.mocked(spawnSync).mockImplementation((_binary, args) => {
            const argv = args as string[];
            if (argv[0] !== 'run') {
                return mock_spawn_sync_result();
            }
            const network_index = argv.indexOf('--network');
            const image_tag_index = network_index + 2;
            const command = argv.slice(image_tag_index + 1).join(' ');
            if (command === 'opencode --version') {
                return mock_spawn_sync_result({ stdout: `${OPENCODE_PINNED_VERSION}\n` });
            }
            if (command === 'opencode export --help') {
                return mock_spawn_sync_result({
                    stderr: '  --sanitize  Redact sensitive transcript/file data\n',
                });
            }
            return mock_spawn_sync_result();
        });

        const result = provider.validate_image('patchlab/opencode:stderr-help');
        expect(result).toEqual({ valid: true, reasons: [] });
    });
});
