import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsoleLogger, set_logger } from '../../../../src/logger.js';
import { RecordingLogger } from '../../../helpers/recording_logger.js';
import { assert_present } from '../../../helpers/assert_present.js';

/** Helper: install a RecordingLogger for one test and return captured warning strings on demand. */
function with_recorded_warnings(): { warnings: () => string[]; restore: () => void } {
    const recording = new RecordingLogger();
    set_logger(recording);
    return {
        warnings: () => recording.calls
            .filter((call) => call.method === 'warn')
            .map((call) => String(call.message)),
        restore: () => set_logger(new ConsoleLogger()),
    };
}

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
}));
vi.mock('node:fs', async (original) => {
    const actual = await original<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: vi.fn(),
    };
});
vi.mock('../../../../src/container_runtime.js', () => ({
    copy_to_container: vi.fn(),
    exec_container: vi.fn(),
    get_runtime_binary: vi.fn(() => 'podman'),
    get_image_home: (user: string) => `/home/${user}`,
    get_working_directory: (user: string) => `/home/${user}/workspace`,
}));
vi.mock('../../../../src/symlink_compatibility.js', () => ({
    find_escape_symlinks: vi.fn(() => []),
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { copy_to_container, exec_container } from '../../../../src/container_runtime.js';
import { find_escape_symlinks } from '../../../../src/symlink_compatibility.js';
import {
    Configured_Tool_Provider,
    compute_manifest_hash,
    type Configured_Tool_Provider_Manifest,
} from '../../../../src/tools/configured_provider/index.js';

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

describe('compute_manifest_hash (task 6.8)', () => {
    it('is stable for unchanged manifests', () => {
        const m = make_manifest();
        expect(compute_manifest_hash(m)).toBe(compute_manifest_hash(m));
    });

    it('changes when dockerfile.install changes', () => {
        const a = compute_manifest_hash(make_manifest({ dockerfile: { install: ['pip install x'], environment: {} } }));
        const b = compute_manifest_hash(make_manifest({ dockerfile: { install: ['pip install y'], environment: {} } }));
        expect(a).not.toBe(b);
    });

    it('changes when dockerfile.environment changes', () => {
        const a = compute_manifest_hash(make_manifest({ dockerfile: { install: [], environment: { PATH: '/a' } } }));
        const b = compute_manifest_hash(make_manifest({ dockerfile: { install: [], environment: { PATH: '/b' } } }));
        expect(a).not.toBe(b);
    });

    it('changes when image_user changes', () => {
        const a = compute_manifest_hash(make_manifest({ image_user: 'alice' }));
        const b = compute_manifest_hash(make_manifest({ image_user: 'bob' }));
        expect(a).not.toBe(b);
    });

    it('changes when image_home changes (defaulted vs explicit override)', () => {
        const a = compute_manifest_hash(make_manifest({ image_home: '/home/patchlab' }));
        const b = compute_manifest_hash(make_manifest({ image_home: '/var/lib/patchlab' }));
        expect(a).not.toBe(b);
    });

    it('changes when base_image changes', () => {
        const a = compute_manifest_hash(make_manifest({ base_image: 'node:22-slim' }));
        const b = compute_manifest_hash(make_manifest({ base_image: 'python:3.12-slim' }));
        expect(a).not.toBe(b);
    });

    it('changes when base_family changes', () => {
        const a = compute_manifest_hash(make_manifest({ base_family: 'debian' }));
        const b = compute_manifest_hash(make_manifest({ base_family: 'alpine' }));
        expect(a).not.toBe(b);
    });

    it('changes when package_manager changes (including transitions like prebuilt+unset → prebuilt+apt)', () => {
        const unset = compute_manifest_hash(make_manifest({ base_family: 'prebuilt', package_manager: undefined }));
        const apt = compute_manifest_hash(make_manifest({ base_family: 'prebuilt', package_manager: 'apt' }));
        const apk = compute_manifest_hash(make_manifest({ base_family: 'prebuilt', package_manager: 'apk' }));
        expect(unset).not.toBe(apt);
        expect(apt).not.toBe(apk);
        expect(unset).not.toBe(apk);
    });

    it('changes when configuration_directory_name changes (default vs override)', () => {
        const a = compute_manifest_hash(make_manifest({ configuration_directory_name: '.aider' }));
        const b = compute_manifest_hash(make_manifest({ configuration_directory_name: '.aider-dev' }));
        expect(a).not.toBe(b);
    });

    it('does NOT change when name changes', () => {
        const a = compute_manifest_hash(make_manifest({ name: 'aider' }));
        const b = compute_manifest_hash(make_manifest({ name: 'cline' }));
        expect(a).toBe(b);
    });

    it('does NOT change when display_name changes', () => {
        const a = compute_manifest_hash(make_manifest({ display_name: 'Aider' }));
        const b = compute_manifest_hash(make_manifest({ display_name: 'Aider (custom)' }));
        expect(a).toBe(b);
    });

    it('does NOT change when authentication changes', () => {
        const a = compute_manifest_hash(make_manifest({ authentication: { method: 'none' } }));
        const b = compute_manifest_hash(make_manifest({
            authentication: { method: 'environment_variables', variable_names: ['OPENAI_API_KEY'] },
        }));
        expect(a).toBe(b);
    });

    it('does NOT change when launch_command changes', () => {
        const a = compute_manifest_hash(make_manifest({ launch_command: ['aider'] }));
        const b = compute_manifest_hash(make_manifest({ launch_command: ['aider', '--yes'] }));
        expect(a).toBe(b);
    });

    it('does NOT change when validation changes', () => {
        const a = compute_manifest_hash(make_manifest({ validation: undefined }));
        const b = compute_manifest_hash(make_manifest({ validation: { command: ['aider', '--version'] } }));
        expect(a).toBe(b);
    });

    it('does NOT change when extractable_artifacts changes', () => {
        const a = compute_manifest_hash(make_manifest({ extractable_artifacts: [] }));
        const b = compute_manifest_hash(make_manifest({
            extractable_artifacts: [{
                name: 'state',
                container_path: '/home/patchlab/.aider/state',
                type: 'directory',
                archive_subpath: 'state',
                required_for_resume: false,
            }],
        }));
        expect(a).toBe(b);
    });

    it('does NOT change when overrides_builtin changes', () => {
        const a = compute_manifest_hash(make_manifest({ overrides_builtin: false }));
        const b = compute_manifest_hash(make_manifest({ overrides_builtin: true }));
        expect(a).toBe(b);
    });

    it('locks the canonical-stringify implementation against a fixed test vector', () => {
        // This vector is the canonical form of the default `make_manifest()` value
        // after canonical-stringify. If this test fails, the canonical-stringify
        // implementation has drifted between Node versions or been refactored.
        // Recompute the expected hash from a known-good run and update the
        // vector below ONLY after confirming the new value is intentional.
        //
        // To regenerate: temporarily change the final `.toBe('49ed02cd')` to
        // `.toBe('')`, run this test once, copy the actual value from the
        // failure output back into the assertion, then verify by re-running.
        const hash = compute_manifest_hash(make_manifest());
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        // Lock the exact hash value so any change to the canonical-stringify
        // implementation is caught.
        expect(hash).toBe('49ed02cd');
    });
});

describe('Configured_Tool_Provider (Section 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    describe('image_specification', () => {
        it('forwards data fields verbatim from the parsed manifest', () => {
            const manifest = make_manifest({
                base_image: 'docker.io/library/node:24-bookworm-slim',
                image_user: 'alice',
                image_home: '/var/lib/alice',
                configuration_directory_name: '.tool',
            });
            const provider = new Configured_Tool_Provider(manifest, '/p/test.yaml');

            expect(provider.image_specification.base_image).toBe('docker.io/library/node:24-bookworm-slim');
            expect(provider.image_specification.image_user).toBe('alice');
            expect(provider.image_specification.image_home).toBe('/var/lib/alice');
            expect(provider.image_specification.configuration_directory_name).toBe('.tool');
        });

        it('returns empty build assets (configured providers do not download binaries)', async () => {
            const provider = new Configured_Tool_Provider(make_manifest(), '/p/test.yaml');
            const assets = await provider.image_specification.prepare_build_assets();
            expect(assets.size).toBe(0);
        });

        it('emits each dockerfile.install entry as a RUN line', () => {
            const manifest = make_manifest({
                dockerfile: { install: ['pip install aider', 'apt-get update && apt-get install -y curl'], environment: {} },
            });
            const provider = new Configured_Tool_Provider(manifest, '/p/test.yaml');
            const lines = provider.image_specification.get_dockerfile_lines([]);
            expect(lines).toEqual([
                'RUN pip install aider',
                'RUN apt-get update && apt-get install -y curl',
            ]);
        });

        it('returns dockerfile.environment as a record', () => {
            const manifest = make_manifest({
                dockerfile: { install: [], environment: { CACHE_DIR: '/tmp', PATH: '/opt/tool/bin' } },
            });
            const provider = new Configured_Tool_Provider(manifest, '/p/test.yaml');
            expect(provider.image_specification.get_dockerfile_environment()).toEqual({
                CACHE_DIR: '/tmp',
                PATH: '/opt/tool/bin',
            });
        });
    });

    describe('get_base_preparation_lines (task 1.2.1 mapping)', () => {
        it('debian non-root: apt + mkdir+useradd+chown, package_manager apt', () => {
            const provider = new Configured_Tool_Provider(make_manifest({ base_family: 'debian', image_user: 'patchlab' }), '/p/x.yaml');
            const prep = provider.image_specification.get_base_preparation_lines(1000);
            expect(prep.package_manager).toBe('apt');
            expect(prep.lines).toHaveLength(2);
            expect(prep.lines[0]).toContain('apt-get');
            expect(prep.lines[0]).toContain('git');
            // useradd shape: mkdir precedes useradd, no -m, chown -R covers full image_home
            const user_setup = prep.lines[1];
            const mkdir_index = user_setup.indexOf('mkdir -p');
            const useradd_index = user_setup.indexOf('useradd');
            const chown_index = user_setup.indexOf('chown -R');
            expect(mkdir_index).toBeGreaterThan(-1);
            expect(useradd_index).toBeGreaterThan(mkdir_index);
            expect(chown_index).toBeGreaterThan(useradd_index);
            expect(user_setup).not.toMatch(/useradd[^&]*\s-m\b/);
            expect(user_setup).toContain('-d /home/patchlab');
            expect(user_setup).toContain('-u 1000');
            expect(user_setup).toContain('-o patchlab');
            expect(user_setup).toMatch(/chown -R patchlab:patchlab \/home\/patchlab\s*$/);
        });

        it('debian root: omits useradd and chown', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({ base_family: 'debian', image_user: 'root', image_home: '/root' }),
                '/p/x.yaml',
            );
            const prep = provider.image_specification.get_base_preparation_lines(1000);
            expect(prep.package_manager).toBe('apt');
            expect(prep.lines).toEqual([
                expect.stringContaining('apt-get'),
                'RUN mkdir -p /root/.aider',
            ]);
            expect(prep.lines.join('\n')).not.toMatch(/useradd/);
            expect(prep.lines.join('\n')).not.toMatch(/chown/);
        });

        it('alpine non-root: apk + adduser-D-H, package_manager apk', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({ base_family: 'alpine', package_manager: 'apk' }),
                '/p/x.yaml',
            );
            const prep = provider.image_specification.get_base_preparation_lines(1000);
            expect(prep.package_manager).toBe('apk');
            expect(prep.lines[0]).toBe('RUN apk add --no-cache git');
            const user_setup = prep.lines[1];
            expect(user_setup).toContain('adduser -D -H -h /home/patchlab');
            expect(user_setup).toContain('-u 1000');
            expect(user_setup).toContain('patchlab');
            expect(user_setup).toContain('chown -R patchlab:patchlab /home/patchlab');
        });

        it('alpine root: omits adduser and chown', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({ base_family: 'alpine', package_manager: 'apk', image_user: 'root', image_home: '/root' }),
                '/p/x.yaml',
            );
            const prep = provider.image_specification.get_base_preparation_lines(1000);
            expect(prep.package_manager).toBe('apk');
            expect(prep.lines).toEqual([
                'RUN apk add --no-cache git',
                'RUN mkdir -p /root/.aider',
            ]);
        });

        it('prebuilt: empty lines; package_manager from manifest', () => {
            const apt_provider = new Configured_Tool_Provider(
                make_manifest({ base_family: 'prebuilt', package_manager: 'apt' }),
                '/p/x.yaml',
            );
            const prep_apt = apt_provider.image_specification.get_base_preparation_lines(1000);
            expect(prep_apt.lines).toEqual([]);
            expect(prep_apt.package_manager).toBe('apt');

            const no_pm_provider = new Configured_Tool_Provider(
                make_manifest({ base_family: 'prebuilt', package_manager: undefined }),
                '/p/x.yaml',
            );
            const prep_unset = no_pm_provider.image_specification.get_base_preparation_lines(1000);
            expect(prep_unset.lines).toEqual([]);
            expect(prep_unset.package_manager).toBeUndefined();
        });
    });

    describe('inject_authentication', () => {
        it('returns { type: none } for method: none', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({ authentication: { method: 'none' } }),
                '/p/x.yaml',
            );
            const result = provider.inject_authentication({ sandbox_id: 'sb' });
            expect(result).toEqual({ type: 'none' });
        });

        it('environment_variables: returns entries when set, omits missing with warning', () => {
            const original_env = { ...process.env };
            process.env.SET_VAR = 'value-a';
            delete process.env.MISSING_VAR;
            const captured = with_recorded_warnings();

            try {
                const provider = new Configured_Tool_Provider(
                    make_manifest({
                        authentication: {
                            method: 'environment_variables',
                            variable_names: ['SET_VAR', 'MISSING_VAR'],
                        },
                    }),
                    '/p/x.yaml',
                );
                const result = provider.inject_authentication({ sandbox_id: 'sb' });
                expect(result).toEqual({
                    type: 'environment_variables',
                    entries: [{ name: 'SET_VAR', value: 'value-a' }],
                });
                const warnings = captured.warnings();
                expect(warnings.some(w => w.includes('MISSING_VAR'))).toBe(true);
                expect(warnings.some(w => w.includes('variable not set'))).toBe(true);
            } finally {
                captured.restore();
                process.env = original_env;
            }
        });

        it('environment_variables: returns none when all variables are missing', () => {
            const original_env = { ...process.env };
            delete process.env.MISSING_A;
            delete process.env.MISSING_B;
            const captured = with_recorded_warnings();

            try {
                const provider = new Configured_Tool_Provider(
                    make_manifest({
                        authentication: {
                            method: 'environment_variables',
                            variable_names: ['MISSING_A', 'MISSING_B'],
                        },
                    }),
                    '/p/x.yaml',
                );
                const result = provider.inject_authentication({ sandbox_id: 'sb' });
                expect(result).toEqual({ type: 'none' });
            } finally {
                captured.restore();
                process.env = original_env;
            }
        });

        it('file_copy: runs copies sequentially and continues on per-copy failure', () => {
            vi.mocked(copy_to_container).mockImplementation((_container, host) => {
                if (host === '/host/missing') {
                    throw new Error('source missing');
                }
            });
            const captured = with_recorded_warnings();

            try {
                const provider = new Configured_Tool_Provider(
                    make_manifest({
                        authentication: {
                            method: 'file_copy',
                            copies: [
                                { host: '/host/missing', container: '/c/missing', uses_home_expansion: false },
                                { host: '/host/ok', container: '/c/ok', uses_home_expansion: false },
                            ],
                        },
                    }),
                    '/p/x.yaml',
                );
                const result = provider.inject_authentication({ sandbox_id: 'sb', container_name: 'c1' });
                expect(result).toEqual({ type: 'file_copy' });
                expect(vi.mocked(copy_to_container)).toHaveBeenCalledTimes(2);
                expect(captured.warnings().some(w => w.includes('source missing'))).toBe(true);
            } finally {
                captured.restore();
            }
        });

        it('file_copy: returns none when container_name is omitted', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({
                    authentication: {
                        method: 'file_copy',
                        copies: [{ host: '/h', container: '/c', uses_home_expansion: false }],
                    },
                }),
                '/p/x.yaml',
            );
            const result = provider.inject_authentication({ sandbox_id: 'sb' });
            expect(result).toEqual({ type: 'none' });
            expect(vi.mocked(copy_to_container)).not.toHaveBeenCalled();
        });
    });

    describe('validate_image', () => {
        it('returns valid when validation is absent', () => {
            const provider = new Configured_Tool_Provider(make_manifest({ validation: undefined }), '/p/x.yaml');
            const result = provider.validate_image('img:tag');
            expect(result).toEqual({ valid: true, reasons: [] });
            expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
        });

        it('passes --user, --workdir, --network none', () => {
            vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
            const provider = new Configured_Tool_Provider(
                make_manifest({
                    image_user: 'patchlab',
                    image_home: '/home/patchlab',
                    validation: { command: ['aider', '--version'] },
                }),
                '/p/x.yaml',
            );
            provider.validate_image('img:tag');

            const captured = vi.mocked(execFileSync).mock.calls.at(-1);
            assert_present(captured);
            const argv = captured[1] as string[];
            expect(argv).toContain('--user');
            expect(argv).toContain('patchlab');
            expect(argv).toContain('--workdir');
            expect(argv).toContain('/home/patchlab');
            expect(argv).toContain('--network');
            expect(argv).toContain('none');
            // --workdir / --user / --network all come before image_tag
            const image_index = argv.indexOf('img:tag');
            expect(argv.indexOf('--workdir')).toBeLessThan(image_index);
            expect(argv.indexOf('--user')).toBeLessThan(image_index);
            expect(argv.indexOf('--network')).toBeLessThan(image_index);
        });

        it('non-zero exit returns invalid with captured stderr', () => {
            vi.mocked(execFileSync).mockImplementation(() => {
                const error = new Error('command failed') as Error & { status: number; stderr: Buffer };
                error.status = 1;
                error.stderr = Buffer.from('aider not found');
                throw error;
            });
            const provider = new Configured_Tool_Provider(
                make_manifest({ validation: { command: ['aider', '--version'] } }),
                '/p/x.yaml',
            );
            const result = provider.validate_image('img:tag');
            expect(result.valid).toBe(false);
            expect(result.reasons[0]).toContain('aider not found');
        });

        it('non-zero exit with empty stderr returns a descriptive reason', () => {
            vi.mocked(execFileSync).mockImplementation(() => {
                const error = new Error('command failed') as Error & { status: number; stderr: Buffer };
                error.status = 42;
                error.stderr = Buffer.from('');
                throw error;
            });
            const provider = new Configured_Tool_Provider(
                make_manifest({ validation: { command: ['aider', '--version'] } }),
                '/p/x.yaml',
            );
            const result = provider.validate_image('img:tag');
            expect(result.valid).toBe(false);
            expect(result.reasons[0]).toContain('exited with code 42');
        });

        it('podman-itself-failed (no status) is distinct from command-exit', () => {
            vi.mocked(execFileSync).mockImplementation(() => {
                throw new Error('podman not found');
            });
            const provider = new Configured_Tool_Provider(
                make_manifest({ validation: { command: ['aider', '--version'] } }),
                '/p/x.yaml',
            );
            const result = provider.validate_image('img:tag');
            expect(result.valid).toBe(false);
            expect(result.reasons[0]).toMatch(/validation could not run/);
            expect(result.reasons[0]).toContain('podman not found');
        });
    });

    describe('inject_session_state', () => {
        it('processes artifacts sequentially via for…of with await (NOT Promise.all)', async () => {
            const order: string[] = [];
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(copy_to_container).mockImplementation((_c, host) => {
                order.push(`copy:${String(host)}`);
            });
            vi.mocked(exec_container).mockImplementation((_c, argv) => {
                order.push(`exec:${(argv as string[]).join(' ')}`);
                return '';
            });

            const provider = new Configured_Tool_Provider(
                make_manifest({
                    extractable_artifacts: [
                        { name: 'a', container_path: '/c/a', type: 'directory', archive_subpath: 'a', required_for_resume: false },
                        { name: 'b', container_path: '/c/b', type: 'directory', archive_subpath: 'b', required_for_resume: false },
                    ],
                }),
                '/p/x.yaml',
            );
            await provider.inject_session_state('container1', '/session/path');

            // Two artifacts processed in order: mkdir-then-copy for each.
            expect(order).toEqual([
                'exec:mkdir -p /c/a',
                expect.stringContaining('copy:'),
                'exec:mkdir -p /c/b',
                expect.stringContaining('copy:'),
            ]);
        });

        it('skips artifacts whose source directory does not exist', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);
            const provider = new Configured_Tool_Provider(
                make_manifest({
                    extractable_artifacts: [
                        { name: 'a', container_path: '/c/a', type: 'directory', archive_subpath: 'a', required_for_resume: false },
                    ],
                }),
                '/p/x.yaml',
            );
            await provider.inject_session_state('container1', '/session/path');
            expect(vi.mocked(copy_to_container)).not.toHaveBeenCalled();
        });

        it('skips artifacts with escape-symlinks and continues', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(find_escape_symlinks).mockImplementation((directory) => {
                // Path-separator-agnostic: archive_subpath 'bad' lands at
                // `${session_path}/artifacts/bad` (POSIX) or
                // `${session_path}\\artifacts\\bad` (Windows). Match the
                // trailing segment regardless of separator.
                if (/[\\/]bad$/.test(String(directory))) {
                    return ['bad/link → ../../etc/passwd'];
                }
                return [];
            });
            const captured = with_recorded_warnings();

            try {
                const provider = new Configured_Tool_Provider(
                    make_manifest({
                        extractable_artifacts: [
                            { name: 'bad', container_path: '/c/bad', type: 'directory', archive_subpath: 'bad', required_for_resume: false },
                            { name: 'good', container_path: '/c/good', type: 'directory', archive_subpath: 'good', required_for_resume: false },
                        ],
                    }),
                    '/p/x.yaml',
                );
                await provider.inject_session_state('container1', '/session/path');

                const warnings = captured.warnings();
                expect(warnings.some(w => w.includes('escape-symlink'))).toBe(true);
                expect(warnings.some(w => w.includes("'bad' artifact"))).toBe(true);
                // 'good' artifact was still copied
                expect(vi.mocked(copy_to_container)).toHaveBeenCalled();
            } finally {
                captured.restore();
            }
        });

        it('preserves symlinks within the artifact directory (spec scenario)', async () => {
            // When an artifact's source directory contains a symlink whose target
            // resolves to another file inside the SAME artifact directory (e.g.,
            // `messages/latest.json → ./session-3.json`), the escape check passes
            // and the artifact is copied normally with the symlink preserved.
            // `find_escape_symlinks` returns [] for within-artifact symlinks — that
            // shape IS what this scenario locks: no warning, copy proceeds.
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(find_escape_symlinks).mockReturnValue([]);
            const captured = with_recorded_warnings();

            try {
                const provider = new Configured_Tool_Provider(
                    make_manifest({
                        extractable_artifacts: [
                            { name: 'messages', container_path: '/c/messages', type: 'directory', archive_subpath: 'messages', required_for_resume: false },
                        ],
                    }),
                    '/p/x.yaml',
                );
                await provider.inject_session_state('container1', '/session/path');

                // No escape-symlink warning emitted, artifact copied normally
                expect(captured.warnings().some(w => w.includes('escape-symlink'))).toBe(false);
                expect(vi.mocked(copy_to_container)).toHaveBeenCalled();
            } finally {
                captured.restore();
            }
        });

        it('rejects cross-artifact symlinks (spec scenario)', async () => {
            // When artifact A's source contains a symlink whose target resolves to
            // artifact B's source (sibling under `<session_path>/artifacts/` but
            // outside A's directory), the symlink is treated as an escape: A is
            // skipped with a warning, processing continues to B. This separates
            // from the parent escape-symlinks test by specifically modeling a
            // cross-sibling target rather than `../../etc/passwd` (the wider
            // filesystem-escape case).
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(find_escape_symlinks).mockImplementation((directory) => {
                if (/[\\/]artifact-a$/.test(String(directory))) {
                    // Target resolves to sibling artifact-b — outside artifact-a's directory
                    return ['artifact-a/cross → ../artifact-b/data.json'];
                }
                return [];
            });
            const captured = with_recorded_warnings();

            try {
                const provider = new Configured_Tool_Provider(
                    make_manifest({
                        extractable_artifacts: [
                            { name: 'artifact-a', container_path: '/c/a', type: 'directory', archive_subpath: 'artifact-a', required_for_resume: false },
                            { name: 'artifact-b', container_path: '/c/b', type: 'directory', archive_subpath: 'artifact-b', required_for_resume: false },
                        ],
                    }),
                    '/p/x.yaml',
                );
                await provider.inject_session_state('container1', '/session/path');

                // artifact-a skipped with warning identifying it and the cross-artifact target
                const warnings = captured.warnings();
                expect(warnings.some(w => w.includes('escape-symlink'))).toBe(true);
                expect(warnings.some(w => w.includes("'artifact-a' artifact"))).toBe(true);
                expect(warnings.some(w => w.includes('artifact-b'))).toBe(true);
                // artifact-b still processed
                expect(vi.mocked(copy_to_container)).toHaveBeenCalled();
            } finally {
                captured.restore();
            }
        });
    });

    describe('getters', () => {
        it('returns null for get_cached_version', () => {
            const provider = new Configured_Tool_Provider(make_manifest(), '/p/x.yaml');
            expect(provider.get_cached_version()).toBeNull();
        });

        it('returns the manifest name for get_openspec_tool_name', () => {
            const provider = new Configured_Tool_Provider(make_manifest({ name: 'aider' }), '/p/x.yaml');
            expect(provider.get_openspec_tool_name()).toBe('aider');
        });

        it('returns launch_command verbatim (defensive copy)', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({ launch_command: ['aider', '--yes'] }),
                '/p/x.yaml',
            );
            const cmd1 = provider.get_launch_command();
            const cmd2 = provider.get_launch_command();
            expect(cmd1).toEqual(['aider', '--yes']);
            expect(cmd1).not.toBe(cmd2); // defensive copy, not shared mutable reference
        });

        it('does not expose get_prompt_launch_command when the manifest omits prompt_launch_command', () => {
            const provider = new Configured_Tool_Provider(make_manifest(), '/p/x.yaml');
            expect(provider.get_prompt_launch_command).toBeUndefined();
        });

        it('builds prompt argv from prompt_launch_command with placeholder substitution', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({
                    prompt_launch_command: ['my-tool', '--message', '{{prompt}}'],
                }),
                '/p/x.yaml',
            );
            expect(provider.get_prompt_launch_command?.('hello')).toEqual([
                'my-tool', '--message', 'hello',
            ]);
        });

        it('uses prompt_resume_launch_command on resume when declared', () => {
            const provider = new Configured_Tool_Provider(
                make_manifest({
                    prompt_launch_command: ['my-tool', '--message', '{{prompt}}'],
                    prompt_resume_launch_command: ['my-tool', '--continue', '--message', '{{prompt}}'],
                }),
                '/p/x.yaml',
            );
            expect(provider.get_prompt_launch_command?.('hello', { resume: true })).toEqual([
                'my-tool', '--continue', '--message', 'hello',
            ]);
        });

        it('exposes manifest_hash and manifest_path for the registry to consume', () => {
            const provider = new Configured_Tool_Provider(make_manifest(), '/manifests/aider.yaml');
            expect(provider.manifest_path).toBe('/manifests/aider.yaml');
            expect(provider.manifest_hash).toMatch(/^[0-9a-f]{8}$/);
        });

        it('get_authentication_method returns the manifest method', () => {
            const file_copy_provider = new Configured_Tool_Provider(
                make_manifest({
                    authentication: {
                        method: 'file_copy',
                        copies: [{ host: '/h', container: '/c', uses_home_expansion: false }],
                    },
                }),
                '/p/x.yaml',
            );
            expect(file_copy_provider.get_authentication_method()).toBe('file_copy');

            const env_provider = new Configured_Tool_Provider(
                make_manifest({
                    authentication: { method: 'environment_variables', variable_names: ['X'] },
                }),
                '/p/x.yaml',
            );
            expect(env_provider.get_authentication_method()).toBe('environment_variables');

            const none_provider = new Configured_Tool_Provider(make_manifest(), '/p/x.yaml');
            expect(none_provider.get_authentication_method()).toBe('none');
        });
    });
});
