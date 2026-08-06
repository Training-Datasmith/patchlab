import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/podman.js', () => ({
    copy_to_container: vi.fn(),
}));

import {
    build_image_specification,
    inject_authentication_none,
    inject_authentication_environment_variables,
    inject_authentication_file_copy,
} from '../../../../src/tools/configured_provider/image_build.js';
import { copy_to_container } from '../../../../src/podman.js';
import { ConsoleLogger, set_logger } from '../../../../src/logger.js';
import { RecordingLogger } from '../../../helpers/recording_logger.js';
import type { Configured_Tool_Provider_Manifest } from '../../../../src/tools/configured_provider/types.js';

const mock_copy_to_container = vi.mocked(copy_to_container);

function make_manifest(overrides: Partial<Configured_Tool_Provider_Manifest> = {}): Configured_Tool_Provider_Manifest {
    return {
        name: 'aider',
        display_name: 'Aider',
        image_user: 'patchlab',
        image_home: '/home/patchlab',
        configuration_directory_name: '.aider',
        base_image: 'docker.io/library/python:3.12-slim',
        base_family: 'debian',
        package_manager: 'apt',
        authentication: { method: 'none' },
        launch_command: ['aider'],
        extractable_artifacts: [],
        overrides_builtin: false,
        ...overrides,
    };
}

describe('build_image_specification', () => {
    it('forwards data fields verbatim', () => {
        const manifest = make_manifest();
        const specification = build_image_specification(manifest);
        expect(specification.base_image).toBe(manifest.base_image);
        expect(specification.image_user).toBe(manifest.image_user);
        expect(specification.image_home).toBe(manifest.image_home);
        expect(specification.configuration_directory_name).toBe(manifest.configuration_directory_name);
    });

    it('prepare_build_assets returns an empty map', async () => {
        const specification = build_image_specification(make_manifest());
        const assets = await specification.prepare_build_assets();
        expect(assets).toBeInstanceOf(Map);
        expect(assets.size).toBe(0);
    });

    it('get_dockerfile_lines prefixes manifest.dockerfile.install with RUN', () => {
        const specification = build_image_specification(make_manifest({
            dockerfile: { install: ['pip install aider', 'aider --version'], environment: {} },
        }));
        expect(specification.get_dockerfile_lines([])).toEqual([
            'RUN pip install aider',
            'RUN aider --version',
        ]);
    });

    it('get_dockerfile_lines returns [] when dockerfile block is absent', () => {
        const specification = build_image_specification(make_manifest());
        expect(specification.get_dockerfile_lines([])).toEqual([]);
    });

    it('get_dockerfile_environment forwards manifest.dockerfile.environment verbatim', () => {
        const specification = build_image_specification(make_manifest({
            dockerfile: { install: [], environment: { NODE_ENV: 'production' } },
        }));
        expect(specification.get_dockerfile_environment()).toEqual({ NODE_ENV: 'production' });
    });

    it('get_dockerfile_environment returns {} when dockerfile block is absent', () => {
        const specification = build_image_specification(make_manifest());
        expect(specification.get_dockerfile_environment()).toEqual({});
    });
});

describe('build_image_specification — get_base_preparation_lines', () => {
    it('debian non-root: apt-get install + useradd + chown', () => {
        const specification = build_image_specification(make_manifest({
            base_family: 'debian',
            image_user: 'patchlab',
            image_home: '/home/patchlab',
            configuration_directory_name: '.aider',
        }));
        const result = specification.get_base_preparation_lines(1000);
        expect(result.lines[0]).toContain('apt-get install');
        expect(result.lines[0]).toContain('git');
        expect(result.lines[1]).toContain('useradd -d /home/patchlab');
        expect(result.lines[1]).toContain('mkdir -p /home/patchlab/.aider');
        expect(result.lines[1]).toContain('chown -R patchlab:patchlab /home/patchlab');
        expect(result.package_manager).toBe('apt');
    });

    it('debian root: skips useradd and chown', () => {
        const specification = build_image_specification(make_manifest({
            base_family: 'debian',
            image_user: 'root',
            configuration_directory_name: '.aider',
        }));
        const result = specification.get_base_preparation_lines(0);
        expect(result.lines[0]).toContain('apt-get install');
        expect(result.lines[1]).toBe('RUN mkdir -p /root/.aider');
        expect(result.lines).toHaveLength(2);
    });

    it('alpine non-root: apk add + adduser + chown', () => {
        const specification = build_image_specification(make_manifest({
            base_family: 'alpine',
            package_manager: 'apk',
            image_user: 'patchlab',
            image_home: '/home/patchlab',
            configuration_directory_name: '.aider',
        }));
        const result = specification.get_base_preparation_lines(1000);
        expect(result.lines[0]).toBe('RUN apk add --no-cache git');
        expect(result.lines[1]).toContain('adduser -D -H -h /home/patchlab');
        expect(result.lines[1]).toContain('chown -R patchlab:patchlab /home/patchlab');
        expect(result.package_manager).toBe('apk');
    });

    it('alpine root: skips adduser and chown', () => {
        const specification = build_image_specification(make_manifest({
            base_family: 'alpine',
            package_manager: 'apk',
            image_user: 'root',
            configuration_directory_name: '.aider',
        }));
        const result = specification.get_base_preparation_lines(0);
        expect(result.lines[0]).toBe('RUN apk add --no-cache git');
        expect(result.lines[1]).toBe('RUN mkdir -p /root/.aider');
    });

    it('prebuilt: empty lines (no bootstrap)', () => {
        const specification = build_image_specification(make_manifest({
            base_family: 'prebuilt',
            package_manager: undefined,
        }));
        const result = specification.get_base_preparation_lines(1000);
        expect(result.lines).toEqual([]);
        expect(result.package_manager).toBeUndefined();
    });

    it('prebuilt with explicit package_manager: forwards it', () => {
        const specification = build_image_specification(make_manifest({
            base_family: 'prebuilt',
            package_manager: 'apt',
        }));
        const result = specification.get_base_preparation_lines(1000);
        expect(result.lines).toEqual([]);
        expect(result.package_manager).toBe('apt');
    });
});

describe('inject_authentication_none', () => {
    it('returns { type: "none" }', () => {
        expect(inject_authentication_none()).toEqual({ type: 'none' });
    });
});

describe('inject_authentication_environment_variables', () => {
    let recording: RecordingLogger;
    const SAVED_TEST_VAR_ONE = process.env.PATCHLAB_TEST_AUTH_VAR_ONE;
    const SAVED_TEST_VAR_TWO = process.env.PATCHLAB_TEST_AUTH_VAR_TWO;

    beforeEach(() => {
        recording = new RecordingLogger();
        set_logger(recording);
        delete process.env.PATCHLAB_TEST_AUTH_VAR_ONE;
        delete process.env.PATCHLAB_TEST_AUTH_VAR_TWO;
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
        if (SAVED_TEST_VAR_ONE === undefined) {
            delete process.env.PATCHLAB_TEST_AUTH_VAR_ONE;
        } else {
            process.env.PATCHLAB_TEST_AUTH_VAR_ONE = SAVED_TEST_VAR_ONE;
        }
        if (SAVED_TEST_VAR_TWO === undefined) {
            delete process.env.PATCHLAB_TEST_AUTH_VAR_TWO;
        } else {
            process.env.PATCHLAB_TEST_AUTH_VAR_TWO = SAVED_TEST_VAR_TWO;
        }
    });

    it('returns entries for variables that are set', () => {
        process.env.PATCHLAB_TEST_AUTH_VAR_ONE = 'value-one';
        const result = inject_authentication_environment_variables(
            make_manifest(),
            ['PATCHLAB_TEST_AUTH_VAR_ONE'],
        );
        expect(result).toEqual({
            type: 'environment_variables',
            entries: [{ name: 'PATCHLAB_TEST_AUTH_VAR_ONE', value: 'value-one' }],
        });
    });

    it('downgrades to { type: "none" } when no variables are set', () => {
        const result = inject_authentication_environment_variables(
            make_manifest(),
            ['PATCHLAB_TEST_AUTH_VAR_ONE', 'PATCHLAB_TEST_AUTH_VAR_TWO'],
        );
        expect(result).toEqual({ type: 'none' });
    });

    it('warns about each unset variable and skips it', () => {
        process.env.PATCHLAB_TEST_AUTH_VAR_TWO = 'value-two';
        const result = inject_authentication_environment_variables(
            make_manifest(),
            ['PATCHLAB_TEST_AUTH_VAR_ONE', 'PATCHLAB_TEST_AUTH_VAR_TWO'],
        );
        expect(result).toEqual({
            type: 'environment_variables',
            entries: [{ name: 'PATCHLAB_TEST_AUTH_VAR_TWO', value: 'value-two' }],
        });
        const warnings = recording.calls.filter((call) => call.method === 'warn');
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0].message)).toContain('PATCHLAB_TEST_AUTH_VAR_ONE');
    });
});

describe('inject_authentication_file_copy', () => {
    let recording: RecordingLogger;

    beforeEach(() => {
        recording = new RecordingLogger();
        set_logger(recording);
        mock_copy_to_container.mockReset();
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    it('invokes copy_to_container for each copy entry', () => {
        inject_authentication_file_copy(make_manifest(), 'container-A', [
            { host: '/host/a', container: '/c/a', uses_home_expansion: false },
            { host: '/host/b', container: '/c/b', uses_home_expansion: false },
        ], '/repo/.patchlab/tools/test.yaml');
        expect(mock_copy_to_container).toHaveBeenCalledTimes(2);
        expect(mock_copy_to_container).toHaveBeenNthCalledWith(1, 'container-A', '/host/a', '/c/a');
        expect(mock_copy_to_container).toHaveBeenNthCalledWith(2, 'container-A', '/host/b', '/c/b');
    });

    it('returns { type: "file_copy" } regardless of failures', () => {
        mock_copy_to_container.mockImplementationOnce(() => { throw new Error('boom'); });
        const result = inject_authentication_file_copy(make_manifest(), 'container-A', [
            { host: '/host/a', container: '/c/a', uses_home_expansion: false },
        ], '/repo/.patchlab/tools/test.yaml');
        expect(result).toEqual({ type: 'file_copy' });
    });

    it('warns when copy_to_container throws, naming host and container', () => {
        mock_copy_to_container.mockImplementationOnce(() => { throw new Error('source not found'); });
        inject_authentication_file_copy(make_manifest(), 'container-A', [
            { host: '/host/missing', container: '/c/missing', uses_home_expansion: false },
        ], '/repo/.patchlab/tools/test.yaml');
        const warnings = recording.calls.filter((call) => call.method === 'warn');
        expect(warnings).toHaveLength(1);
        const message = String(warnings[0].message);
        expect(message).toContain('/host/missing');
        expect(message).toContain('/c/missing');
        expect(message).toContain('source not found');
    });

    it('re-checks containment at injection: refuses a host path that escaped the repository tree, copies an in-tree one', () => {
        // TOCTOU defense. When a `repository_root` is supplied (per-source
        // manifest), each host path is re-verified immediately before the copy —
        // a path that now resolves outside the tree (e.g. swapped for a symlink
        // after the trust prompt) is refused, while a legitimate in-tree path
        // still copies.
        const repository_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-toctou-')));
        const in_tree_host = path.join(repository_root, 'token');
        fs.writeFileSync(in_tree_host, 'token-bytes');
        try {
            inject_authentication_file_copy(
                make_manifest(),
                'container-A',
                [
                    { host: '/etc/passwd', container: '/c/escaped', uses_home_expansion: false },
                    { host: in_tree_host, container: '/c/token', uses_home_expansion: false },
                ],
                path.join(repository_root, '.patchlab/tools/test.yaml'),
                repository_root,
            );

            // Out-of-tree copy refused; only the in-tree copy reaches podman.
            expect(mock_copy_to_container).toHaveBeenCalledTimes(1);
            expect(mock_copy_to_container).toHaveBeenCalledWith('container-A', in_tree_host, '/c/token');
            const warnings = recording.calls.filter((call) => call.method === 'warn');
            expect(warnings).toHaveLength(1);
            expect(String(warnings[0].message)).toContain('/etc/passwd');
            expect(String(warnings[0].message)).toContain('escaped repository tree');
        } finally {
            fs.rmSync(repository_root, { recursive: true, force: true });
        }
    });
});
