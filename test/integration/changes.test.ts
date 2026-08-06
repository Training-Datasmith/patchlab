import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { destroy_sandbox } from '../../src/sandbox/index.js';
import { diff_sandbox } from '../../src/changes.js';
import { exec_container } from '../../src/podman.js';

const GIT_TEST_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
};

interface Fixture {
    source_directory: string;
    sandbox_id: string;
    container_name: string;
}

async function build_baseline_fixture(): Promise<Fixture> {
    const source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-src-'));
    execFileSync('git', ['init'], { cwd: source_directory });
    fs.writeFileSync(path.join(source_directory, 'a.txt'), 'original a\n');
    fs.writeFileSync(path.join(source_directory, 'b.txt'), 'original b\n');
    execFileSync('git', ['add', '-A'], { cwd: source_directory });
    execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], {
        cwd: source_directory,
        env: GIT_TEST_ENVIRONMENT,
    });

    const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
    return {
        source_directory,
        sandbox_id: manifest.id,
        container_name: manifest.container_name,
    };
}

async function tear_down_fixture(fixture: Fixture): Promise<void> {
    await destroy_sandbox(fixture.sandbox_id, { force: true });
    fs.rmSync(fixture.source_directory, { recursive: true, force: true });
}

// Tests 1-5 share one baseline sandbox. Each test's mutations touch a known
// subset of {a.txt, b.txt, c.txt, renamed.txt}; the `afterEach` block reverts
// every possible mutation so the next test starts from baseline. Tests 6 and
// 7 sit in their own describes (below) because their mutations either
// OVERLAP with siblings' paths (test 6 modifies a.txt AND deletes b.txt AND
// adds c.txt — same paths as tests 1, 3, 2) OR mutate HEAD itself (test 7
// commits a `.gitignore` into the baseline, which would permanently shift
// the comparison reference for siblings). See
// [documents/testing-strategy.md](../../documents/testing-strategy.md)
// "Overlapping mutations need their own sandbox".
describe('change detection — shared baseline (orthogonal mutations)', () => {
    let fixture: Fixture;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeAll(async () => {
        fixture = await build_baseline_fixture();
    }, 120_000);

    afterAll(async () => {
        await tear_down_fixture(fixture);
    });

    afterEach(() => {
        // Revert every mutation any sibling test in this describe might
        // produce. `git checkout -- a.txt b.txt` restores tracked files
        // (handles test 1's `echo > a.txt` modify, test 3's `rm b.txt`
        // delete, and test 5's `git mv a.txt renamed.txt` rename's
        // a.txt-side). `rm -f c.txt renamed.txt` removes untracked files
        // added by test 2 and test 5. Both run unconditionally so a
        // partially-mutated state from a failing test still leaves the
        // baseline clean for the next test.
        exec_container(
            fixture.container_name,
            ['git', 'checkout', '--', 'a.txt', 'b.txt'],
            { cwd },
        );
        exec_container(
            fixture.container_name,
            ['sh', '-c', 'rm -f c.txt renamed.txt'],
            { cwd },
        );
    });

    it('detects modified files', () => {
        exec_container(fixture.container_name, ['sh', '-c', "echo 'modified a' > a.txt"], { cwd });
        const changes = diff_sandbox(fixture.sandbox_id);
        expect(changes).toEqual([{ relative_path: 'a.txt', type: 'modify' }]);

        // `diff_sandbox` stages with `git add -A`, reads `git diff --cached
        // --name-status HEAD`, and then RESETS the index. A regression where
        // the reset was dropped (or pointed at the wrong ref) would leave
        // the working-tree mutation staged — silently breaking the next
        // session's "what changed since HEAD" computation, since changes
        // already in the index don't appear as new edits. Lock the cleanup.
        const status_after = exec_container(
            fixture.container_name,
            ['git', 'status', '--porcelain'],
            { cwd },
        );
        // The working-tree edit must remain visible (' M a.txt'), but the
        // index must be clean — a left-staged change would appear as
        // 'M  a.txt' (uppercase M in the index column).
        expect(status_after).toMatch(/^ M a\.txt$/m);
        expect(status_after).not.toMatch(/^M {2}/m);
        expect(status_after).not.toMatch(/^A {2}/m);
    });

    it('detects added files', () => {
        exec_container(fixture.container_name, ['sh', '-c', "echo 'new file' > c.txt"], { cwd });
        const changes = diff_sandbox(fixture.sandbox_id);
        expect(changes).toEqual([{ relative_path: 'c.txt', type: 'add' }]);
    });

    it('detects deleted files', () => {
        exec_container(fixture.container_name, ['rm', 'b.txt'], { cwd });
        const changes = diff_sandbox(fixture.sandbox_id);
        expect(changes).toEqual([{ relative_path: 'b.txt', type: 'delete' }]);
    });

    it('returns empty array when no changes', () => {
        const changes = diff_sandbox(fixture.sandbox_id);
        expect(changes).toEqual([]);
    });

    it('reports a `git mv` rename as delete + add (locks the --no-renames contract)', () => {
        // `git diff --cached --name-status` defaults (since git 2.9) to
        // detecting renames and emitting `R<score>\told\tnew` — three
        // tab-separated fields, not two. `parse_name_status` only handles
        // two-field rows, so without the `--no-renames` flag in
        // `diff_sandbox` the rename would silently surface as a
        // `'modify'` of an `old\tnew` path with an embedded tab. This
        // test pins the corrective contract: `diff_sandbox` SHALL surface
        // a rename as a clean `'delete'` of the old name plus an `'add'`
        // of the new name.
        exec_container(fixture.container_name, ['git', 'mv', 'a.txt', 'renamed.txt'], { cwd });

        const changes = diff_sandbox(fixture.sandbox_id);
        const by_path = new Map(changes.map((c) => [c.relative_path, c.type]));
        expect(by_path.get('a.txt')).toBe('delete');
        expect(by_path.get('renamed.txt')).toBe('add');
        // No mangled tab-embedded path key surfaced (the failure mode of
        // a regression that removed --no-renames).
        for (const change of changes) {
            expect(change.relative_path).not.toContain('\t');
            expect(change.type).not.toBe('R100');
        }
    });
});

// Test 6 mutates a.txt, b.txt, and c.txt simultaneously — the SAME paths
// the shared-baseline tests above touch individually. The `afterEach`
// cleanup would still revert the working tree, but a regression in the
// `diff_sandbox` cumulative-state path could mask the bug under that
// cleanup. Run it against a freshly-created sandbox to lock the
// multi-mutation contract independently of the shared block.
describe('change detection — composed multi-file mutations', () => {
    let fixture: Fixture;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeAll(async () => {
        fixture = await build_baseline_fixture();
    }, 120_000);

    afterAll(async () => {
        await tear_down_fixture(fixture);
    });

    it('detects multiple change types simultaneously', () => {
        exec_container(fixture.container_name, ['sh', '-c', "echo 'modified' > a.txt"], { cwd });
        exec_container(fixture.container_name, ['rm', 'b.txt'], { cwd });
        exec_container(fixture.container_name, ['sh', '-c', "echo 'new' > c.txt"], { cwd });

        const changes = diff_sandbox(fixture.sandbox_id);
        const by_path = new Map(changes.map((c) => [c.relative_path, c.type]));
        expect(by_path.get('a.txt')).toBe('modify');
        expect(by_path.get('b.txt')).toBe('delete');
        expect(by_path.get('c.txt')).toBe('add');
    });
});

// Test 7 commits a `.gitignore` into HEAD. That permanently shifts the
// "compare against baseline" reference for downstream tests, so it cannot
// share the shared-baseline sandbox above.
describe('change detection — gitignore mutates HEAD', () => {
    let fixture: Fixture;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeAll(async () => {
        fixture = await build_baseline_fixture();
    }, 120_000);

    afterAll(async () => {
        await tear_down_fixture(fixture);
    });

    it('respects .gitignore in change detection', () => {
        // Add a .gitignore and commit it
        exec_container(fixture.container_name, ['sh', '-c', "echo '*.log' > .gitignore"], { cwd });
        exec_container(fixture.container_name, ['git', 'add', '.gitignore'], { cwd });
        exec_container(fixture.container_name, ['git', 'commit', '-m', 'add gitignore'], { cwd });

        // Now add both a .log and .txt file
        exec_container(fixture.container_name, ['sh', '-c', "echo 'log data' > debug.log"], { cwd });
        exec_container(fixture.container_name, ['sh', '-c', "echo 'new file' > c.txt"], { cwd });

        const changes = diff_sandbox(fixture.sandbox_id);
        expect(changes.find((c) => c.relative_path === 'debug.log')).toBeUndefined();
        expect(changes.find((c) => c.relative_path === 'c.txt')).toBeDefined();
    });
});
