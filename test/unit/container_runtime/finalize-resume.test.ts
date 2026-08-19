import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Container_Runtime_Kind } from '../../../src/container_runtime/types.js';

const exec_runtime_mock = vi.fn();
const container_exists_mock = vi.fn((_name: string) => true);
const get_container_runtime_mock = vi.fn((): { kind: Container_Runtime_Kind; binary: string } => ({
    kind: 'podman',
    binary: 'podman',
}));

vi.mock('../../../src/container_runtime/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/container_runtime/registry.js')>();
    return {
        ...actual,
        exec_runtime: (...args: Parameters<typeof actual.exec_runtime>) => exec_runtime_mock(...args),
        container_exists: (name: string) => container_exists_mock(name),
        get_container_runtime: () => get_container_runtime_mock(),
    };
});

vi.mock('node:crypto', () => ({
    randomBytes: vi.fn(() => Buffer.from('abcd1234', 'hex')),
}));

import {
    finalize_resumed_container,
    resume_previous_container_backup_name,
} from '../../../src/container_runtime/index.js';

describe('finalize_resumed_container', () => {
    beforeEach(() => {
        exec_runtime_mock.mockReset();
        container_exists_mock.mockReset();
        container_exists_mock.mockReturnValue(true);
        get_container_runtime_mock.mockReturnValue({ kind: 'podman', binary: 'podman' });
    });

    it('renames previous to backup then staging to final when previous occupies the final name', () => {
        const backup_name = resume_previous_container_backup_name('pl-finalize');

        const result = finalize_resumed_container(
            'c-pl-finalize-resume-staging',
            'c-pl-finalize',
            'c-pl-finalize',
            'pl-finalize',
        );

        expect(result).toBe(backup_name);
        expect(exec_runtime_mock.mock.calls.map((call) => call[0])).toEqual([
            ['rename', 'c-pl-finalize', backup_name],
            ['rename', 'c-pl-finalize-resume-staging', 'c-pl-finalize'],
        ]);
    });

    it('restores the previous container when staging rename fails after backup rename', () => {
        const backup_name = resume_previous_container_backup_name('pl-finalize');
        container_exists_mock.mockImplementation((name: string) =>
            name === 'c-pl-finalize' || name === backup_name,
        );
        exec_runtime_mock.mockImplementation((args: string[]) => {
            if (args[0] === 'rename' && args[1] === 'c-pl-finalize-resume-staging') {
                throw new Error('staging rename failed');
            }
            return Buffer.from('');
        });

        expect(() => finalize_resumed_container(
            'c-pl-finalize-resume-staging',
            'c-pl-finalize',
            'c-pl-finalize',
            'pl-finalize',
        )).toThrow(/staging rename failed/);

        expect(exec_runtime_mock.mock.calls.map((call) => call[0])).toEqual([
            ['rename', 'c-pl-finalize', backup_name],
            ['rename', 'c-pl-finalize-resume-staging', 'c-pl-finalize'],
            ['rename', backup_name, 'c-pl-finalize'],
        ]);
    });

    it('only renames staging when no previous container exists', () => {
        container_exists_mock.mockReturnValue(false);

        const result = finalize_resumed_container(
            'c-pl-finalize-resume-staging',
            'c-pl-finalize',
            'c-pl-finalize',
            'pl-finalize',
        );

        expect(result).toBeNull();
        expect(exec_runtime_mock.mock.calls.map((call) => call[0])).toEqual([
            ['rename', 'c-pl-finalize-resume-staging', 'c-pl-finalize'],
        ]);
    });

    it('backup-renames a previous container that uses a non-final name', () => {
        const backup_name = resume_previous_container_backup_name('pl-finalize');

        const result = finalize_resumed_container(
            'c-pl-finalize-resume-staging',
            'c-legacy-name',
            'c-pl-finalize',
            'pl-finalize',
        );

        expect(result).toBe(backup_name);
        expect(exec_runtime_mock.mock.calls.map((call) => call[0])).toEqual([
            ['rename', 'c-legacy-name', backup_name],
            ['rename', 'c-pl-finalize-resume-staging', 'c-pl-finalize'],
        ]);
        expect(exec_runtime_mock.mock.calls.some((call) => call[0][0] === 'rm')).toBe(false);
    });
});
