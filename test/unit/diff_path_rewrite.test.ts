import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { make_diff_path_rewriter, type Path_Rewrite_Entry } from '../../src/diff_path_rewrite.js';

async function run_rewriter(rewrites: Path_Rewrite_Entry[], input: string, chunks?: number[]): Promise<string> {
    const transform = make_diff_path_rewriter(rewrites);
    const buffers: Buffer[] = [];
    const collector = new Promise<void>((resolve, reject) => {
        transform.on('data', (chunk: Buffer) => buffers.push(chunk));
        transform.on('end', () => resolve());
        transform.on('error', reject);
    });
    if (chunks === undefined) {
        Readable.from([Buffer.from(input, 'binary')]).pipe(transform);
    } else {
        let cursor = 0;
        const parts: Buffer[] = [];
        for (const size of chunks) {
            parts.push(Buffer.from(input.substring(cursor, cursor + size), 'binary'));
            cursor += size;
        }
        if (cursor < input.length) {
            parts.push(Buffer.from(input.substring(cursor), 'binary'));
        }
        Readable.from(parts).pipe(transform);
    }
    await collector;
    return Buffer.concat(buffers).toString('binary');
}

describe('make_diff_path_rewriter: simple modification with mount_name !== source_prefix', () => {
    it('rewrites diff --git, --- a/, +++ b/ header lines for one mount', async () => {
        const input = [
            'diff --git a/frontend/app.tsx b/frontend/app.tsx',
            'index abc123..def456 100644',
            '--- a/frontend/app.tsx',
            '+++ b/frontend/app.tsx',
            '@@ -1,3 +1,3 @@',
            ' const a = 1;',
            '-const b = 2;',
            '+const b = 3;',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'src/ui' }], input);
        expect(output).toContain('diff --git a/src/ui/app.tsx b/src/ui/app.tsx');
        expect(output).toContain('--- a/src/ui/app.tsx');
        expect(output).toContain('+++ b/src/ui/app.tsx');
        expect(output).toContain(' const a = 1;');
        expect(output).toContain('-const b = 2;');
        expect(output).toContain('+const b = 3;');
        expect(output).toContain('@@ -1,3 +1,3 @@');
        expect(output).toContain('index abc123..def456 100644');
    });
});

describe('make_diff_path_rewriter: rename chunks', () => {
    it('rewrites both rename from and rename to under one mount', async () => {
        const input = [
            'diff --git a/frontend/old.ts b/frontend/new.ts',
            'similarity index 100%',
            'rename from frontend/old.ts',
            'rename to frontend/new.ts',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'src' }], input);
        expect(output).toContain('diff --git a/src/old.ts b/src/new.ts');
        expect(output).toContain('rename from src/old.ts');
        expect(output).toContain('rename to src/new.ts');
        expect(output).not.toContain('frontend/');
    });
});

describe('make_diff_path_rewriter: content lines pass through verbatim', () => {
    it('does not rewrite content lines starting with +, -, space, @@, or \\ even if they contain mount_name/ substrings', async () => {
        const input = [
            'diff --git a/frontend/doc.md b/frontend/doc.md',
            '--- a/frontend/doc.md',
            '+++ b/frontend/doc.md',
            '@@ -1,5 +1,5 @@',
            ' The frontend/ directory contains the UI code.',
            '-Old: frontend/legacy.txt was deprecated.',
            '+New: frontend/replacement.txt is preferred.',
            ' Reference: see frontend/README.md for details.',
            '\\ No newline at end of file',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'src' }], input);
        // Header lines rewritten.
        expect(output).toContain('diff --git a/src/doc.md b/src/doc.md');
        expect(output).toContain('--- a/src/doc.md');
        expect(output).toContain('+++ b/src/doc.md');
        // Content lines preserved BYTE-FOR-BYTE — the `frontend/` substring inside content
        // is untouched. This is the streaming-correctness guarantee.
        expect(output).toContain(' The frontend/ directory contains the UI code.');
        expect(output).toContain('-Old: frontend/legacy.txt was deprecated.');
        expect(output).toContain('+New: frontend/replacement.txt is preferred.');
        expect(output).toContain(' Reference: see frontend/README.md for details.');
        expect(output).toContain('\\ No newline at end of file');
        expect(output).toContain('@@ -1,5 +1,5 @@');
    });
});

describe('make_diff_path_rewriter: binary patch markers pass through', () => {
    it('does not rewrite GIT binary patch, delta, literal headers or base85 body lines', async () => {
        const input = [
            'diff --git a/frontend/image.png b/frontend/image.png',
            'index abc..def 100644',
            'GIT binary patch',
            'delta 123',
            'zcmZQz#0&8FZkHTC%nTd|3o`+I00MqI3JC#`',
            '',
            'literal 0',
            'HcmV?d00001',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'assets' }], input);
        expect(output).toContain('diff --git a/assets/image.png b/assets/image.png');
        // Binary patch markers are not header keywords — they pass through.
        expect(output).toContain('GIT binary patch');
        expect(output).toContain('delta 123');
        expect(output).toContain('zcmZQz#0&8FZkHTC%nTd|3o`+I00MqI3JC#`');
        expect(output).toContain('literal 0');
        expect(output).toContain('HcmV?d00001');
    });
});

describe('make_diff_path_rewriter: identity case', () => {
    it('returns a pass-through when every entry has mount_name === source_prefix', async () => {
        const input = [
            'diff --git a/src/foo.ts b/src/foo.ts',
            '--- a/src/foo.ts',
            '+++ b/src/foo.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');
        const output = await run_rewriter(
            [
                { mount_name: 'src', source_prefix: 'src' },
                { mount_name: 'lib', source_prefix: 'lib' },
            ],
            input,
        );
        // Byte-for-byte identity.
        expect(output).toBe(input);
    });
});

describe('make_diff_path_rewriter: multi-rewrite mixed case', () => {
    it('rewrites only the entries where mount_name !== source_prefix and leaves matching ones untouched', async () => {
        const input = [
            'diff --git a/frontend/app.tsx b/frontend/app.tsx',
            '--- a/frontend/app.tsx',
            '+++ b/frontend/app.tsx',
            '@@ -1 +1 @@',
            '-a',
            '+b',
            'diff --git a/server/routes.ts b/server/routes.ts',
            '--- a/server/routes.ts',
            '+++ b/server/routes.ts',
            '@@ -1 +1 @@',
            '-c',
            '+d',
            '',
        ].join('\n');
        const output = await run_rewriter(
            [
                { mount_name: 'frontend', source_prefix: 'src/ui' },
                { mount_name: 'server', source_prefix: 'server' },
            ],
            input,
        );
        // `frontend` rewritten to `src/ui`.
        expect(output).toContain('diff --git a/src/ui/app.tsx b/src/ui/app.tsx');
        expect(output).toContain('--- a/src/ui/app.tsx');
        expect(output).toContain('+++ b/src/ui/app.tsx');
        // `server` left as-is (identity).
        expect(output).toContain('diff --git a/server/routes.ts b/server/routes.ts');
        expect(output).toContain('--- a/server/routes.ts');
        expect(output).toContain('+++ b/server/routes.ts');
    });
});

describe('make_diff_path_rewriter: chunk-boundary behavior', () => {
    it('produces the same output regardless of where chunk boundaries fall', async () => {
        const input = [
            'diff --git a/frontend/app.tsx b/frontend/app.tsx',
            '--- a/frontend/app.tsx',
            '+++ b/frontend/app.tsx',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');
        const expected = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'src' }], input);
        // Now split the input across awkward chunk boundaries — mid-line, mid-header keyword, etc.
        const chunked = await run_rewriter(
            [{ mount_name: 'frontend', source_prefix: 'src' }],
            input,
            [3, 5, 7, 11, 13, 17, 19, 23, 29],
        );
        expect(chunked).toBe(expected);
    });

    it('emits the final partial line if input does not end with newline', async () => {
        const input = 'diff --git a/frontend/last b/frontend/last';
        const output = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'src' }], input);
        expect(output).toBe('diff --git a/src/last b/src/last');
    });
});

describe('make_diff_path_rewriter: unmatched mount names pass through', () => {
    it('leaves a header line unchanged when its leading path segment is not in the rewrite map', async () => {
        const input = [
            'diff --git a/other/foo b/other/foo',
            '--- a/other/foo',
            '+++ b/other/foo',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'frontend', source_prefix: 'src' }], input);
        // No rewrite happens for `other` — only `frontend` is in the map.
        expect(output).toContain('diff --git a/other/foo b/other/foo');
        expect(output).toContain('--- a/other/foo');
        expect(output).toContain('+++ b/other/foo');
    });
});

describe('make_diff_path_rewriter: empty source_prefix (mount IS the repository root)', () => {
    it('rewrites <mount>/foo to foo (repo-relative) — strips the slash that follows the matched segment', async () => {
        const input = [
            'diff --git a/external/foo.txt b/external/foo.txt',
            '--- a/external/foo.txt',
            '+++ b/external/foo.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'external', source_prefix: '' }], input);
        // Without the slash-strip, the output would be malformed `a//foo.txt`.
        expect(output).toContain('diff --git a/foo.txt b/foo.txt');
        expect(output).toContain('--- a/foo.txt');
        expect(output).toContain('+++ b/foo.txt');
        expect(output).not.toContain('//');
    });

    it('rewrites rename chunks under an empty-source-prefix mount', async () => {
        const input = [
            'diff --git a/external/old.ts b/external/new.ts',
            'similarity index 100%',
            'rename from external/old.ts',
            'rename to external/new.ts',
            '',
        ].join('\n');
        const output = await run_rewriter([{ mount_name: 'external', source_prefix: '' }], input);
        expect(output).toContain('diff --git a/old.ts b/new.ts');
        expect(output).toContain('rename from old.ts');
        expect(output).toContain('rename to new.ts');
        expect(output).not.toContain('//');
        expect(output).not.toContain('rename from /');
        expect(output).not.toContain('rename to /');
    });

    it('handles a file at a nested path under an empty-source-prefix mount', async () => {
        const input = 'diff --git a/external/lib/inner/deep.ts b/external/lib/inner/deep.ts\n';
        const output = await run_rewriter([{ mount_name: 'external', source_prefix: '' }], input);
        expect(output).toBe('diff --git a/lib/inner/deep.ts b/lib/inner/deep.ts\n');
    });
});
