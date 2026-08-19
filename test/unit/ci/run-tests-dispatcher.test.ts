import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

describe('run-tests dispatcher', () => {
    it('runs every tier even when an earlier tier fails', () => {
        const source = fs.readFileSync(
            path.join(REPOSITORY_ROOT, 'scripts/run-tests.mjs'),
            'utf-8',
        );

        expect(source).toContain('function merge_exit_code');
        expect(source).not.toMatch(/status\s\|\|=\sawait run_vitest/);
        expect(source).not.toMatch(/exit_code\s\|\|=\sawait run_integration_tiers/);
        expect(source).not.toMatch(/exit_code\s\|\|=\sawait run\('node', \['scripts\/test-posix\.mjs'\]\)/);
        expect(source).toContain("merge_exit_code(exit_code, await run('node', ['scripts/test-posix.mjs']))");
    });
});
