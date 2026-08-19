import { describe, it, expect } from 'vitest';
import { get_working_directory } from '../../../src/sandbox/index.js';
import { CONTAINER_WORKING_DIR } from '../../../src/container_runtime.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

describe('sandbox.get_working_directory — fallback path', () => {
    install_isolated_home_hooks('patchlab-getwd-');

    it('returns CONTAINER_WORKING_DIR when the sandbox manifest cannot be read', () => {
        // No archive directory exists for this id — `read_manifest` throws,
        // the function catches, and falls back to the image-agnostic default.
        expect(get_working_directory('does-not-exist')).toBe(CONTAINER_WORKING_DIR);
    });
});
