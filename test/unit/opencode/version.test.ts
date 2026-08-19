import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OPENCODE_PINNED_VERSION } from '../../../src/opencode/version.js';

describe('OpenCode pinned toolchain metadata (R10)', () => {
    it('documents the pinned npm version in source for release bumps', () => {
        const version_source = fs.readFileSync(
            path.join(process.cwd(), 'src/opencode/version.ts'),
            'utf-8',
        );

        expect(version_source).toContain(`OPENCODE_PINNED_VERSION = '${OPENCODE_PINNED_VERSION}'`);
        expect(OPENCODE_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });
});
