import { describe, it, expect } from 'vitest';
import {
    build_volume_mounts,
    build_environment_variables,
} from '../../src/container_options.js';
import type { Detected_Requirements } from '../../src/detect/index.js';

function empty_requirements(overrides: Partial<Detected_Requirements> = {}): Detected_Requirements {
    return {
        system_packages: [],
        volume_mounts: [],
        environment_variables: [],
        services: [],
        npm_packages: [],
        ...overrides,
    };
}

describe('build_volume_mounts', () => {
    it('includes non-socket mounts regardless of socket approval', () => {
        const merged = empty_requirements({
            volume_mounts: [{
                type: 'volume_mount',
                host_path: '/host/project',
                container_path: '/home/node/workspace',
                source: 'source_code',
            }],
        });

        expect(build_volume_mounts(merged, false)).toEqual([
            '/host/project:/home/node/workspace',
        ]);
        expect(build_volume_mounts(merged, true)).toEqual([
            '/host/project:/home/node/workspace',
        ]);
    });

    it('filters podman and docker socket mounts when socket_approved is false', () => {
        const merged = empty_requirements({
            volume_mounts: [
                {
                    type: 'volume_mount',
                    host_path: '/run/user/1000/podman/podman.sock',
                    container_path: '/run/podman/podman.sock',
                    source: 'source_code',
                },
                {
                    type: 'volume_mount',
                    host_path: '/var/run/docker.sock',
                    container_path: '/var/run/docker.sock',
                    source: 'docker_compose',
                },
                {
                    type: 'volume_mount',
                    host_path: '/host/project',
                    container_path: '/home/node/workspace',
                    source: 'source_code',
                },
            ],
        });

        expect(build_volume_mounts(merged, false)).toEqual([
            '/host/project:/home/node/workspace',
        ]);
    });

    it('includes socket mounts when socket_approved is true', () => {
        const merged = empty_requirements({
            volume_mounts: [{
                type: 'volume_mount',
                host_path: '/run/user/1000/podman/podman.sock',
                container_path: '/run/podman/podman.sock',
                source: 'source_code',
            }],
        });

        expect(build_volume_mounts(merged, true)).toEqual([
            '/run/user/1000/podman/podman.sock:/run/podman/podman.sock',
        ]);
    });
});

describe('build_environment_variables', () => {
    it('copies detected environment variables from merged requirements', () => {
        const merged = empty_requirements({
            environment_variables: [{
                type: 'environment_var',
                key: 'FOO',
                value: 'bar',
                source: 'docker_compose',
            }],
        });

        expect(build_environment_variables(merged, [], false)).toEqual({ FOO: 'bar' });
    });

    it('derives CONTAINER_HOST from an approved podman socket mount', () => {
        const volume_mounts = [
            '/run/user/1000/podman/podman.sock:/run/podman/podman.sock',
        ];

        expect(build_environment_variables(empty_requirements(), volume_mounts, true)).toEqual({
            CONTAINER_HOST: 'unix:///run/podman/podman.sock',
        });
    });

    it('derives DOCKER_HOST from an approved docker socket mount', () => {
        const volume_mounts = [
            '/var/run/docker.sock:/var/run/docker.sock',
        ];

        expect(build_environment_variables(empty_requirements(), volume_mounts, true)).toEqual({
            DOCKER_HOST: 'unix:///var/run/docker.sock',
        });
    });

    it('does not derive socket hosts when socket_approved is false', () => {
        const volume_mounts = [
            '/run/user/1000/podman/podman.sock:/run/podman/podman.sock',
            '/var/run/docker.sock:/var/run/docker.sock',
        ];

        expect(build_environment_variables(empty_requirements(), volume_mounts, false)).toEqual({});
    });

    it('merges detected variables with derived socket hosts', () => {
        const merged = empty_requirements({
            environment_variables: [{
                type: 'environment_var',
                key: 'API_KEY',
                value: 'secret',
                source: 'configuration_files',
            }],
        });
        const volume_mounts = [
            '/run/user/1000/podman/podman.sock:/run/podman/podman.sock',
        ];

        expect(build_environment_variables(merged, volume_mounts, true)).toEqual({
            API_KEY: 'secret',
            CONTAINER_HOST: 'unix:///run/podman/podman.sock',
        });
    });
});
