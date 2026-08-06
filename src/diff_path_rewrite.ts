import { Transform, type TransformCallback } from 'node:stream';

/**
 * One entry in the rewrite map. The transform stream replaces occurrences of
 * `<mount_name>/` with `<source_prefix>/` only on unified-diff header lines.
 */
export interface Path_Rewrite_Entry {
    mount_name: string;
    source_prefix: string;
}

/**
 * Build a Node `stream.Transform` that rewrites unified-diff header lines.
 *
 * For each rewrite entry where `mount_name !== source_prefix`, the transform
 * replaces `<mount_name>/` with `<source_prefix>/` only in five specific
 * line-prefix contexts (see `rewrite_header_line`). Content lines, hunk
 * markers, binary-patch markers, and any line not matching one of the five
 * header prefixes pass through unchanged.
 *
 * Identity case: when every entry has `mount_name === source_prefix`, the
 * returned transform is a true pass-through with no per-line work.
 *
 * The transform is line-buffered. It uses 'binary' string encoding so binary
 * patch chunk lines (base85-encoded text terminated by `\n`) round-trip
 * byte-for-byte through the rewrite step.
 */
export function make_diff_path_rewriter(rewrites: Path_Rewrite_Entry[]): Transform {
    const all_identity = rewrites.every((entry) => entry.mount_name === entry.source_prefix);
    if (all_identity) {
        return new Transform({
            transform(chunk: Buffer, _encoding, callback: TransformCallback) {
                callback(null, chunk);
            },
        });
    }

    const rewrite_map = new Map<string, string>();
    for (const entry of rewrites) {
        rewrite_map.set(entry.mount_name, entry.source_prefix);
    }

    let line_carry = '';

    return new Transform({
        transform(chunk: Buffer, _encoding, callback: TransformCallback) {
            line_carry += chunk.toString('binary');
            const parts = line_carry.split('\n');
            line_carry = parts.pop() ?? '';
            if (parts.length === 0) {
                callback();
                return;
            }
            const out: string[] = [];
            for (const line of parts) {
                out.push(rewrite_header_line(line, rewrite_map));
                out.push('\n');
            }
            callback(null, Buffer.from(out.join(''), 'binary'));
        },
        flush(callback: TransformCallback) {
            if (line_carry.length === 0) {
                callback();
                return;
            }
            const tail = rewrite_header_line(line_carry, rewrite_map);
            line_carry = '';
            callback(null, Buffer.from(tail, 'binary'));
        },
    });
}

/**
 * Rewrite a single unified-diff line. Lines matching one of these five header
 * forms have their `<mount_name>/` segment replaced with `<source_prefix>/`:
 *
 *   - `diff --git a/<X> b/<Y>` — both `a/<X>` and `b/<Y>` are rewritten.
 *   - `--- a/<path>` — `<path>` is rewritten if its first segment is a known
 *     mount name.
 *   - `+++ b/<path>` — same.
 *   - `rename from <path>` — same.
 *   - `rename to <path>` — same.
 *
 * Lines NOT starting with one of these prefixes are returned unchanged. A
 * `<path>` whose first segment is not in `rewrite_map` is returned unchanged
 * (defensive: the per-repository pathspec filter upstream should ensure every
 * file is under one of the mounts, but the rewriter does not assume so).
 *
 * Paths are NOT unquoted. The in-container `git diff` is invoked with
 * `-c core.quotePath=false` so paths arrive unquoted; quoted-path lines (if
 * they ever appear) pass through unchanged.
 */
function rewrite_header_line(line: string, rewrite_map: Map<string, string>): string {
    if (line.startsWith('diff --git ')) {
        return rewrite_diff_git_line(line, rewrite_map);
    }

    if (line.startsWith('--- a/')) {
        const rewritten = rewrite_first_segment(line.substring('--- a/'.length), rewrite_map);
        return '--- a/' + rewritten;
    }

    if (line.startsWith('+++ b/')) {
        const rewritten = rewrite_first_segment(line.substring('+++ b/'.length), rewrite_map);
        return '+++ b/' + rewritten;
    }

    if (line.startsWith('rename from ')) {
        const rewritten = rewrite_first_segment(line.substring('rename from '.length), rewrite_map);
        return 'rename from ' + rewritten;
    }

    if (line.startsWith('rename to ')) {
        const rewritten = rewrite_first_segment(line.substring('rename to '.length), rewrite_map);
        return 'rename to ' + rewritten;
    }

    return line;
}

/**
 * Rewrite a `diff --git a/<X> b/<Y>` line. Parses the two paths around the
 * mandatory ` b/` separator and rewrites each independently. If the line does
 * not match the expected shape (quoted paths, malformed input), returns the
 * line unchanged.
 */
function rewrite_diff_git_line(line: string, rewrite_map: Map<string, string>): string {
    const PREFIX = 'diff --git ';
    const rest = line.substring(PREFIX.length);
    if (!rest.startsWith('a/')) {
        return line;
    }

    const separator_index = rest.indexOf(' b/');
    if (separator_index < 0) {
        return line;
    }

    const a_path = rest.substring('a/'.length, separator_index);
    const b_path = rest.substring(separator_index + ' b/'.length);
    const rewritten_a = rewrite_first_segment(a_path, rewrite_map);
    const rewritten_b = rewrite_first_segment(b_path, rewrite_map);
    return PREFIX + 'a/' + rewritten_a + ' b/' + rewritten_b;
}

/**
 * Replace the first `/`-delimited segment of `path` if it matches a key in
 * `rewrite_map`. Pass through unchanged otherwise.
 *
 * When `replacement` is the empty string (the rewrite entry's `source_prefix`
 * is `""`, i.e. the host source is the repository root), the slash following
 * the matched segment is consumed as well: `frontend/foo.txt` →`foo.txt`,
 * not `/foo.txt`. Leaving the slash would produce `diff --git a//foo.txt`
 * style malformed headers that `git apply` cannot handle.
 */
function rewrite_first_segment(path: string, rewrite_map: Map<string, string>): string {
    const slash_index = path.indexOf('/');
    if (slash_index < 0) {
        const replacement = rewrite_map.get(path);
        return replacement === undefined ? path : replacement;
    }

    const head = path.substring(0, slash_index);
    const replacement = rewrite_map.get(head);
    if (replacement === undefined) {
        return path;
    }

    return (replacement === '')
        ? path.substring(slash_index + 1)
        : replacement + path.substring(slash_index);
}