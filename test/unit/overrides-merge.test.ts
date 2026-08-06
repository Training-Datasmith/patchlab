import { describe, it, expect } from 'vitest';
import { merge_requirements, split_mount } from '../../src/overrides_merge.js';
import type { Detected_Requirements } from '../../src/detect/index.js';

describe('overrides-merge', () => {
    describe('merge_requirements', () => {
        const base_detected: Detected_Requirements = {
            system_packages: [
                { type: 'system_package', capability: 'postgres-client', source: 'ci_configuration' },
                { type: 'system_package', capability: 'curl', source: 'ci_configuration' },
            ],
            volume_mounts: [
                { type: 'volume_mount', host_path: '/run/podman/podman.sock', container_path: '/run/podman/podman.sock', source: 'source_code' },
            ],
            environment_variables: [
                { type: 'environment_var', key: 'DATABASE_URL', value: 'postgres://ci/test', source: 'ci_configuration' },
            ],
            services: [
                { type: 'service', name: 'postgres', source: 'ci_configuration' },
            ],
            npm_packages: [],
        };

        it('passes through detected when no overrides', () => {
            const result = merge_requirements(base_detected, {});
            expect(result.system_packages).toHaveLength(2);
            expect(result.environment_variables).toHaveLength(1);
        });

        it('ignores detected requirements by exact match', () => {
            const result = merge_requirements(base_detected, {
                ignore_detected: ['postgres-client'],
            });
            expect(result.system_packages.map((r) => r.capability)).toEqual(['curl']);
        });

        it('ignores detected environment variable by key', () => {
            const result = merge_requirements(base_detected, {
                ignore_detected: ['DATABASE_URL'],
            });
            expect(result.environment_variables).toHaveLength(0);
        });

        it('ignores detected service by name', () => {
            const result = merge_requirements(base_detected, {
                ignore_detected: ['postgres'],
            });
            expect(result.services).toHaveLength(0);
        });

        it('explicit addition wins over ignore', () => {
            const result = merge_requirements(base_detected, {
                ignore_detected: ['curl'],
                requirements: { system_packages: ['curl'] },
            });
            expect(result.system_packages.map((r) => r.capability)).toContain('curl');
        });

        it('adds requirements not in detected', () => {
            const result = merge_requirements(base_detected, {
                requirements: {
                    system_packages: ['jq'],
                    environment_variables: { API_KEY: 'test123' },
                },
            });
            expect(result.system_packages.map((r) => r.capability)).toContain('jq');
            expect(result.environment_variables.some((r) => r.key === 'API_KEY')).toBe(true);
        });

        it('overrides environment variable value from .patchlab.json', () => {
            const result = merge_requirements(base_detected, {
                requirements: {
                    environment_variables: { DATABASE_URL: 'postgres://local/dev' },
                },
            });
            const db = result.environment_variables.find((r) => r.key === 'DATABASE_URL');
            expect(db?.value).toBe('postgres://local/dev');
        });

        it('splits volume mounts with Windows drive letters correctly', () => {
            const detected: Detected_Requirements = {
                system_packages: [],
                volume_mounts: [],
                environment_variables: [],
                services: [],
                npm_packages: [],
            };
            const result = merge_requirements(detected, {
                requirements: {
                    volume_mounts: [String.raw`C:\Users\foo\data:/container/data`],
                },
            });
            expect(result.volume_mounts).toHaveLength(1);
            expect(result.volume_mounts[0].host_path).toBe(String.raw`C:\Users\foo\data`);
            expect(result.volume_mounts[0].container_path).toBe('/container/data');
        });
    });

    describe('split_mount', () => {
        it('splits a standard Unix mount', () => {
            expect(split_mount('/host/path:/container/path')).toEqual(['/host/path', '/container/path']);
        });

        it('splits a mount with a Windows drive letter', () => {
            expect(split_mount(String.raw`C:\Users\foo:/container/data`)).toEqual([String.raw`C:\Users\foo`, '/container/data']);
        });

        it('handles lowercase drive letter', () => {
            expect(split_mount(String.raw`d:\project:/workspace`)).toEqual([String.raw`d:\project`, '/workspace']);
        });

        it('throws when no colon separator is present', () => {
            expect(() => split_mount('/no-separator')).toThrow("missing ':'");
        });

        it('handles a bare drive root', () => {
            expect(split_mount(String.raw`C:\:/mnt`)).toEqual(['C:\\', '/mnt']);
        });
    });
});
