import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FILE_COPY_TEST_TOOL } from '../../helpers/stub_tool_provider.js';
import * as fs from 'node:fs';

// Mock child_process before importing podman module
vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { get_image_tool_state, create_container, install_package } from '../../../src/podman.js';
import { assert_present } from '../../helpers/assert_present.js';

const mocked_exec = vi.mocked(execFileSync);

describe('get_image_tool_state', () => {
    beforeEach(() => {
        mocked_exec.mockReset();
    });

    it('returns authenticated when label value is authenticated', () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('authenticated\n'));
        expect(get_image_tool_state('test:latest', FILE_COPY_TEST_TOOL)).toBe('authenticated');
    });

    it('returns installed when label value is installed', () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('installed\n'));
        expect(get_image_tool_state('test:latest', FILE_COPY_TEST_TOOL)).toBe('installed');
    });

    it('returns absent when label is missing', () => {
        mocked_exec.mockReturnValueOnce(Buffer.from('<no value>\n'));
        expect(get_image_tool_state('test:latest', FILE_COPY_TEST_TOOL)).toBe('absent');
    });

    it('returns absent when image does not exist', () => {
        mocked_exec.mockImplementation(() => { throw new Error('not found'); });
        expect(get_image_tool_state('nonexistent:latest', 'gemini-cli-oauth')).toBe('absent');
    });
});

describe('create_container', () => {
    beforeEach(() => {
        mocked_exec.mockReset();
    });

    it('throws on duplicate environment variable keys', () => {
        expect(() => create_container('test', 'image:latest', {
            environment_variables: { MY_KEY: 'value1' },
            extra_environment_variables: { MY_KEY: 'value2' },
        })).toThrow('Duplicate environment variable key: MY_KEY');
    });

    it('passes env vars via --env-file (not on the command line)', () => {
        // Capture the env-file path and read its contents before the call returns
        // (the implementation unlinks the file in a finally block).
        let captured_env_file_contents: string | null = null;
        mocked_exec.mockImplementation((..._args: unknown[]) => {
            const call_arguments = _args[1] as string[];
            const flag_index = call_arguments.indexOf('--env-file');
            if (flag_index >= 0) {
                const file_path = call_arguments[flag_index + 1];
                captured_env_file_contents = fs.readFileSync(file_path, 'utf-8');
            }

            return Buffer.from('');
        });

        create_container('test', 'image:latest', {
            extra_environment_variables: { GEMINI_API_KEY: 'test-key' },
        });

        const call_arguments = mocked_exec.mock.calls[0][1] as string[];
        expect(call_arguments).toContain('--env-file');
        // No -e flag for individual env vars (the security regression).
        expect(call_arguments).not.toContain('-e');
        // No raw value on the command line.
        expect(call_arguments.some((argument) => argument.includes('GEMINI_API_KEY=test-key'))).toBe(false);
        // Value did make it through the env-file.
        expect(captured_env_file_contents).toContain('GEMINI_API_KEY=test-key');
    });

    it('passes both base and extra env vars through one env-file', () => {
        let captured: string | null = null;
        mocked_exec.mockImplementation((..._args: unknown[]) => {
            const call_arguments = _args[1] as string[];
            const flag_index = call_arguments.indexOf('--env-file');
            if (flag_index >= 0) {
                captured = fs.readFileSync(call_arguments[flag_index + 1], 'utf-8');
            }
            return Buffer.from('');
        });

        create_container('test', 'image:latest', {
            environment_variables: { CONTAINER_HOST: 'unix:///run/podman.sock' },
            extra_environment_variables: { GEMINI_API_KEY: 'test-key' },
        });

        expect(captured).toContain('CONTAINER_HOST=unix:///run/podman.sock');
        expect(captured).toContain('GEMINI_API_KEY=test-key');
    });

    it('rejects env values containing newlines (would silently truncate via env-file)', () => {
        expect(() => create_container('test', 'image:latest', {
            extra_environment_variables: { BAD: 'line1\nline2' },
        })).toThrow(/contains a newline/);
    });

    it('omits --env-file entirely when no env vars are supplied', () => {
        create_container('test', 'image:latest');
        const call_arguments = mocked_exec.mock.calls[0][1] as string[];
        expect(call_arguments).not.toContain('--env-file');
    });
});

describe('install_package', () => {
    beforeEach(() => {
        mocked_exec.mockReset();
    });

    it('uses dpkg -s to check if package is installed', () => {
        mocked_exec.mockReturnValue(Buffer.from(''));
        install_package('container-1', 'curl');
        const shell_command = (mocked_exec.mock.calls[0][1] as string[]).at(-1);
        assert_present(shell_command);
        expect(shell_command).toContain('dpkg -s curl');
        expect(shell_command).not.toContain('which');
    });

    it('rejects package names with shell metacharacters', () => {
        expect(() => install_package('c', 'curl; rm -rf /')).toThrow('does not match');
    });

    it('rejects uppercase package names', () => {
        expect(() => install_package('c', 'Curl')).toThrow('does not match');
    });

    it('accepts typical multi-word package names', () => {
        mocked_exec.mockReturnValue(Buffer.from(''));
        install_package('c', 'postgresql-client');
        expect(mocked_exec).toHaveBeenCalled();
    });

    it('accepts single-character package names', () => {
        mocked_exec.mockReturnValue(Buffer.from(''));
        install_package('c', 'r');
        expect(mocked_exec).toHaveBeenCalled();
    });

    it('accepts package names with dots and plus signs', () => {
        mocked_exec.mockReturnValue(Buffer.from(''));
        install_package('c', 'g++');
        expect(mocked_exec).toHaveBeenCalled();
    });
});
