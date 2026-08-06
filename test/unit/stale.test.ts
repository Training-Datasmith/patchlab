import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConsoleLogger, set_logger } from '../../src/logger.js';
import { RecordingLogger } from '../helpers/recording_logger.js';

// `node:child_process` is mocked at module level so `get_image_capabilities`
// can be exercised without invoking real podman. Tests that don't override
// the mock simply see `execFileSync` throw (the default vi.fn implementation)
// — which exercises the "podman not available / image not found" error path.
vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(() => {
        throw new Error('execFileSync not configured for this test');
    }),
    spawn: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

const mocked_execFileSync = vi.mocked(execFileSync);

// Tasks 6.7–6.9 are integration tests requiring podman.
// Here we test the logic functions that don't need podman.

describe('stale image check logic', () => {
    it('returns not stale when no capabilities detected', async () => {
        // Mock get_image_capabilities to avoid podman dependency
        const { check_stale_image } = await import('../../src/stale.js');
        // With no detected capabilities, stale check should be a no-op
        const result = check_stale_image('nonexistent-image', []);
        expect(result.stale).toBe(false);
        expect(result.missing).toEqual([]);
        expect(result.no_label).toBe(false);
    });

    it('returns stale with no_label when image has no capabilities label', async () => {
        const { check_stale_image } = await import('../../src/stale.js');
        // This will call podman which will fail for a nonexistent image
        // get_image_capabilities returns null when podman fails
        const result = check_stale_image('nonexistent-image-xyz', ['postgres-client']);
        expect(result.stale).toBe(true);
        expect(result.no_label).toBe(true);
        expect(result.missing).toEqual(['postgres-client']);
    });
});


describe('get_image_capabilities (podman label inspection)', () => {
    afterEach(() => {
        mocked_execFileSync.mockReset();
        mocked_execFileSync.mockImplementation(() => {
            throw new Error('execFileSync not configured for this test');
        });
    });

    it('returns the parsed capability list when the image has a populated label', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('postgres-client,curl,git\n'));
        const { get_image_capabilities } = await import('../../src/stale.js');

        expect(get_image_capabilities('image:tag')).toEqual(['postgres-client', 'curl', 'git']);
    });

    it('trims whitespace around each parsed capability', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('  postgres-client ,  curl  , git \n'));
        const { get_image_capabilities } = await import('../../src/stale.js');

        expect(get_image_capabilities('image:tag')).toEqual(['postgres-client', 'curl', 'git']);
    });

    it('drops empty tokens (trailing comma, double comma)', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('postgres-client,,curl,\n'));
        const { get_image_capabilities } = await import('../../src/stale.js');

        expect(get_image_capabilities('image:tag')).toEqual(['postgres-client', 'curl']);
    });

    it('returns null when the label is the literal "<no value>" (podman placeholder for absent labels)', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('<no value>\n'));
        const { get_image_capabilities } = await import('../../src/stale.js');

        expect(get_image_capabilities('image:tag')).toBeNull();
    });

    it('returns null when the inspect output is empty', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('\n'));
        const { get_image_capabilities } = await import('../../src/stale.js');

        expect(get_image_capabilities('image:tag')).toBeNull();
    });
});

describe('check_stale_image (comparison against image label)', () => {
    afterEach(() => {
        mocked_execFileSync.mockReset();
        mocked_execFileSync.mockImplementation(() => {
            throw new Error('execFileSync not configured for this test');
        });
    });

    it('returns not stale when every detected capability is present on the image', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('postgres-client,curl,git\n'));
        const { check_stale_image } = await import('../../src/stale.js');

        const result = check_stale_image('image:tag', ['postgres-client', 'curl']);
        expect(result).toEqual({ stale: false, missing: [], no_label: false });
    });

    it('flags every capability not present on the image as missing', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('curl\n'));
        const { check_stale_image } = await import('../../src/stale.js');

        const result = check_stale_image('image:tag', ['postgres-client', 'curl', 'git']);
        expect(result.stale).toBe(true);
        expect(result.no_label).toBe(false);
        expect(result.missing).toEqual(['postgres-client', 'git']);
    });

    it('returns not stale when image is a superset of the detected capabilities', async () => {
        mocked_execFileSync.mockReturnValue(Buffer.from('postgres-client,curl,git,jq\n'));
        const { check_stale_image } = await import('../../src/stale.js');

        const result = check_stale_image('image:tag', ['curl']);
        expect(result.stale).toBe(false);
        expect(result.missing).toEqual([]);
    });
});
