/**
 * Structural lock for JSON file-parsing discipline in src/.
 *
 * All JSON reads from disk SHALL go through `parse_file_as_json` from
 * src/json_validators.ts, which strips a leading UTF-8 BOM before calling
 * JSON.parse. The inline form `JSON.parse(fs.readFileSync(...))` bypasses
 * that and will silently fail on Windows-editor-saved files that begin with
 * a BOM.
 *
 * The tokenizer walks source character by character so occurrences inside
 * comments, string literals, and template literals are not flagged.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    line_number_at,
    skip_block_comment,
    skip_line_comment,
    skip_quoted_string,
    skip_template_literal,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIRECTORY = path.join(REPOSITORY_ROOT, 'src');

const BYPASS_PATTERN = /\bJSON\.parse\(fs\.readFileSync\(/g;

function find_bypass_call_sites(source: string): { line: number }[] {
    const found: { line: number }[] = [];
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === '/' && next === '/') {
            i = skip_line_comment(source, i);
            continue;
        }

        if (c === '/' && next === '*') {
            i = skip_block_comment(source, i);
            continue;
        }

        if (c === '`') {
            i = skip_template_literal(source, i);
            continue;
        }

        if (c === '"' || c === "'") {
            i = skip_quoted_string(source, i);
            continue;
        }

        BYPASS_PATTERN.lastIndex = i;
        const match = BYPASS_PATTERN.exec(source);
        if (match?.index === i) {
            found.push({ line: line_number_at(source, i) });
            i += match[0].length;
            continue;
        }

        i++;
    }

    return found;
}

describe('JSON parse discipline: no bare JSON.parse(fs.readFileSync(...)) in src/', () => {
    it('all JSON file reads go through parse_file_as_json', () => {
        const all_files: string[] = [];
        collect_typescript_files(SRC_DIRECTORY, all_files);

        const offenders: { file: string; line: number }[] = [];

        for (const file_path of all_files) {
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const call_site of find_bypass_call_sites(contents)) {
                offenders.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: call_site.line,
                });
            }
        }

        expect(
            offenders,
            `Bare JSON.parse(fs.readFileSync(...)) found in src/ — use parse_file_as_json instead:\n${offenders
                .map((o) => `  ${o.file}:${o.line}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a real bypass, ignores look-alikes in strings/comments/templates', () => {
        const source = [
            'const value = 1;',
            'const data = JSON.parse(fs.readFileSync(value, "utf-8"));',  // line 2 — violation
            'const text = "JSON.parse(fs.readFileSync(value))";',         // string — ignored
            '// JSON.parse(fs.readFileSync(value))',                       // line comment — ignored
            '/* JSON.parse(fs.readFileSync(value)) */',                    // block comment — ignored
            'const tpl = `JSON.parse(fs.readFileSync(${value}))`;',       // template — ignored
        ].join('\n');

        expect(find_bypass_call_sites(source)).toEqual([{ line: 2 }]);
    });
});
