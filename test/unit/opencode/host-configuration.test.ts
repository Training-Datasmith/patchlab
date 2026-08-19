import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CREDENTIAL_STAGING_DIRECTORY_MODE,
    CREDENTIAL_STAGING_FILE_MODE,
    prepare_opencode_host_configuration,
    rewrite_loopback_urls,
} from '../../../src/opencode/host_configuration.js';
import { host_opencode_auth_path } from '../../../src/opencode/paths.js';
import { HOST_PATCHLAB_INTERNAL } from '../../../src/tools/host_access.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

describe('rewrite_loopback_urls', () => {
    it('rewrites localhost and 127.0.0.1 URLs with mapped listen ports', () => {
        const port_map = new Map<number, number>([[11434, 11434]]);
        const input = '{"provider":{"ollama":{"options":{"baseURL":"http://localhost:11434/v1"}}}}';
        const output = rewrite_loopback_urls(input, HOST_PATCHLAB_INTERNAL, port_map);
        expect(output).toContain(`http://${HOST_PATCHLAB_INTERNAL}:11434/v1`);
        expect(output).not.toContain('localhost');
    });

    it('rewrites IPv6 loopback URLs', () => {
        const port_map = new Map<number, number>([[8080, 18080]]);
        const input = 'baseURL: http://[::1]:8080/v1';
        const output = rewrite_loopback_urls(input, HOST_PATCHLAB_INTERNAL, port_map);
        expect(output).toContain(`http://${HOST_PATCHLAB_INTERNAL}:18080/v1`);
    });

    it('leaves non-loopback URLs unchanged', () => {
        const port_map = new Map<number, number>();
        const input = '{"baseURL":"https://api.anthropic.com/v1"}';
        expect(rewrite_loopback_urls(input, HOST_PATCHLAB_INTERNAL, port_map)).toBe(input);
    });
});

describe('prepare_opencode_host_configuration credential staging (R17)', () => {
    install_isolated_home_hooks('patchlab-opencode-staging-perms-');

    let sandbox_directory: string;

    beforeEach(() => {
        sandbox_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-opencode-sandbox-')),
        );

        const host_auth = host_opencode_auth_path();
        fs.mkdirSync(path.dirname(host_auth), { recursive: true });
        fs.writeFileSync(host_auth, '{"token":"secret"}\n', 'utf-8');
    });

    it('hardens opencode-staging and auth.json modes on POSIX', () => {
        if (process.platform === 'win32') {
            return;
        }

        const prepared = prepare_opencode_host_configuration({
            sandbox_directory,
            image_home: '/home/patchlab',
            copy_host_configuration: false,
            copy_host_auth: true,
            proxy_local_models: false,
        });

        expect(fs.statSync(prepared.staging_directory).mode & 0o777)
            .toBe(CREDENTIAL_STAGING_DIRECTORY_MODE);

        const staged_auth = path.join(prepared.staging_directory, 'auth.json');
        expect(fs.statSync(staged_auth).mode & 0o777)
            .toBe(CREDENTIAL_STAGING_FILE_MODE);
    });

    it('leaves auth.json world-inaccessible after permission overlay rewrite', () => {
        if (process.platform === 'win32') {
            return;
        }

        const host_configuration = path.join(
            process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
            'opencode',
        );
        fs.mkdirSync(host_configuration, { recursive: true });
        fs.writeFileSync(
            path.join(host_configuration, 'opencode.json'),
            JSON.stringify({ permission: { edit: 'deny' } }),
            'utf-8',
        );

        prepare_opencode_host_configuration({
            sandbox_directory,
            image_home: '/home/patchlab',
            copy_host_configuration: true,
            copy_host_auth: true,
            proxy_local_models: false,
        });

        const staged_auth = path.join(sandbox_directory, 'opencode-staging', 'auth.json');
        expect(fs.statSync(staged_auth).mode & 0o777)
            .toBe(CREDENTIAL_STAGING_FILE_MODE);
        expect(fs.statSync(path.dirname(staged_auth)).mode & 0o777)
            .toBe(CREDENTIAL_STAGING_DIRECTORY_MODE);
    });
});
