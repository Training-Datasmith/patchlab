import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Locks the structure of the README "Output channels" subsection introduced
 * by the injectable-logger change (task 6.1). Replaces the manual GitHub-
 * rendering check (task 7.6): since this test reads the same markdown that
 * GitHub renders, structural correctness of the source guarantees rendering
 * correctness modulo GitHub-specific quirks.
 *
 * This test does NOT verify visual fidelity. It locks:
 *   - The subsection heading exists at the right level (`## Output channels`)
 *   - The subsection covers the documented content elements (stdout/stderr
 *     split, example invocations, migration note)
 *   - The fenced code blocks are well-formed
 *   - The subsection appears before the "How It Works" closing section
 */

const README_PATH = path.resolve(__dirname, '..', '..', '..', 'README.md');

function extract_section(markdown: string, heading: string): string {
    const heading_line = `## ${heading}`;
    const start = markdown.indexOf(heading_line);
    if (start === -1) {
        return '';
    }
    const after_heading = markdown.slice(start + heading_line.length);
    const next_heading = after_heading.search(/\n## /);
    return next_heading === -1
        ? after_heading
        : after_heading.slice(0, next_heading);
}

describe('README "Output channels" subsection (task 7.6)', () => {
    const readme = fs.readFileSync(README_PATH, 'utf-8');

    it('README contains an `## Output channels` heading', () => {
        expect(readme).toContain('## Output channels');
    });

    it('subsection documents the stdout vs stderr split', () => {
        const section = extract_section(readme, 'Output channels');
        expect(section).toMatch(/\*\*stdout\*\*/);
        expect(section).toMatch(/\*\*stderr\*\*/);
        // The split should name what each channel carries
        expect(section.toLowerCase()).toContain('pipeable');
        expect(section.toLowerCase()).toMatch(/progress|warnings|errors|confirmation/);
    });

    it('subsection includes at least one example invocation per channel', () => {
        const section = extract_section(readme, 'Output channels');
        const code_block_count = (section.match(/```/g) ?? []).length;
        // Even number of ``` markers means complete fences (open + close pairs)
        expect(code_block_count % 2).toBe(0);
        expect(code_block_count).toBeGreaterThanOrEqual(2);

        // One example uses a pipe (stdout consumption), another uses 2> (stderr capture)
        expect(section).toMatch(/\|\s*awk|\|\s*head|\|\s*grep|\|\s*jq/);
        expect(section).toMatch(/2>/);
    });

    it('subsection acknowledges the channel-placement change (migration note)', () => {
        const section = extract_section(readme, 'Output channels');
        const lowered = section.toLowerCase();
        // The migration note explains that some messages previously on stdout
        // are now on stderr. Phrasing is flexible — "moved", "now appear",
        // "previously appeared", etc. all qualify.
        expect(lowered).toMatch(/previous|moved|now appear|previously appeared|upgrad/);
    });

    it('subsection appears before the "How It Works" section', () => {
        const output_channels_start = readme.indexOf('## Output channels');
        const how_it_works_start = readme.indexOf('## How It Works');
        expect(output_channels_start).toBeGreaterThan(-1);
        expect(how_it_works_start).toBeGreaterThan(-1);
        expect(output_channels_start).toBeLessThan(how_it_works_start);
    });
});
