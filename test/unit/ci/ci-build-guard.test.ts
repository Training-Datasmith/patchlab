import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..');

function job_block(workflow: string, job_name: string): string {
    const start = workflow.indexOf(`${job_name}:`);
    expect(start, `${job_name} job must exist`).toBeGreaterThan(-1);
    const remainder = workflow.slice(start + job_name.length + 1);
    const next_job_match = remainder.match(/\n  [a-z][\w-]*:/);
    if (next_job_match === null || next_job_match.index === undefined) {
        return workflow.slice(start);
    }

    return workflow.slice(start, start + job_name.length + 1 + next_job_match.index);
}

describe('CI build guardrails', () => {
    const workflow = fs.readFileSync(
        path.join(REPOSITORY_ROOT, '.github/workflows/ci.yml'),
        'utf-8',
    );

    it.each([
        'test-unit',
        'test-posix',
        'test-integration',
        'test-macos-platform',
    ])('runs npm run build before tests in %s', (job_name) => {
        const block = job_block(workflow, job_name);
        const build_index = block.indexOf('npm run build');
        const vitest_index = block.indexOf('npx vitest run');

        expect(build_index, `${job_name} must run npm run build`).toBeGreaterThan(-1);
        expect(vitest_index, `${job_name} must run vitest`).toBeGreaterThan(-1);
        expect(build_index, `${job_name} must build before vitest`).toBeLessThan(vitest_index);
    });

    it('already builds before nerdctl integration on macOS', () => {
        const block = job_block(workflow, 'test-macos-nerdctl');
        const build_index = block.indexOf('npm run build');
        const vitest_index = block.indexOf('npx vitest run');

        expect(build_index).toBeGreaterThan(-1);
        expect(build_index).toBeLessThan(vitest_index);
    });
});
