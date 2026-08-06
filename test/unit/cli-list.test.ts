import { describe, it, expect } from 'vitest';
import { format_list_header, format_list_row } from '../../src/cli_list.js';
import type { Sandbox_Info } from '../../src/sandbox/index.js';

function make_info(overrides: Partial<Sandbox_Info> = {}): Sandbox_Info {
    return {
        id: 'pl-list-id',
        source_path: '/repo-a/src',
        additional_source_count: 0,
        created_at: '2026-05-23T00:00:00.000Z',
        container_name: 'patchlab-list',
        container_status: 'stopped',
        tool: 'gemini-cli-oauth',
        ...overrides,
    };
}

describe('cli list output: header row', () => {
    it('format_list_header renders the fixed column headings', () => {
        expect(format_list_header()).toBe('ID  CONTAINER  STATUS  SOURCE  CREATED');
    });
});

describe('cli list output: (+N more) indicator', () => {
    it('single-source list row has no indicator suffix', () => {
        const row = format_list_row(make_info({ additional_source_count: 0 }));
        expect(row).not.toContain('(+');
        expect(row).toContain('/repo-a/src');
    });

    it('same-repository multi-source list row has (+1 more) suffix', () => {
        // A patchlab created from two sources in the same repository
        // (additional_source_count = 1) renders the indicator at the same
        // count as the cross-repository case below.
        const row = format_list_row(make_info({ additional_source_count: 1 }));
        expect(row).toContain('/repo-a/src (+1 more)');
    });

    it('cross-repository multi-source list row has (+1 more) suffix with identical format', () => {
        // A patchlab created from sources in two different repositories
        // renders the indicator identically to the same-repository case — the
        // list view conflates same-repository and cross-repository multi-source by
        // counting sources, NOT repositories. `inspect` carries the
        // distinction.
        const row = format_list_row(make_info({ additional_source_count: 1 }));
        expect(row).toContain('/repo-a/src (+1 more)');
    });

    it('N=3 multi-source list row has (+2 more) suffix', () => {
        const row = format_list_row(make_info({ additional_source_count: 2 }));
        expect(row).toContain('(+2 more)');
    });

    it('indicator N equals manifest.sources.length - 1', () => {
        // additional_source_count is derived from manifest.sources.length - 1
        // by list_sandboxes; the format helper just renders the value.
        for (const n of [0, 1, 2, 5, 10]) {
            const row = format_list_row(make_info({ additional_source_count: n }));
            if (n === 0) {
                expect(row).not.toContain('(+');
            } else {
                expect(row).toContain(`(+${n} more)`);
            }
        }
    });
});