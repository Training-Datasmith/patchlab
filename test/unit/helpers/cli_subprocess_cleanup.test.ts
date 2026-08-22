import { describe, it, expect } from 'vitest';
import { extract_created_sandbox_ids } from '../../helpers/cli_subprocess_cleanup.js';

describe('extract_created_sandbox_ids', () => {
    it('parses ids from stdout and stderr and deduplicates by caller', () => {
        const output = [
            'Resolved 1 source(s).',
            'Patchlab created: 11111111-2222-3333-4444-555555555555',
            'Patchlab created: 11111111-2222-3333-4444-555555555555',
            'Container: patchlab-11111111-2222-3333-4444-555555555555',
        ].join('\n');

        expect(extract_created_sandbox_ids(output)).toEqual([
            '11111111-2222-3333-4444-555555555555',
            '11111111-2222-3333-4444-555555555555',
        ]);
    });
});
