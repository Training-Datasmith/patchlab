import { read_manifest, resolve_manifest_tool } from './manifest.js';
import { build_archive_path } from './archive.js';
import { exec_container } from './container_runtime.js';
import { get_provider, compute_container_workspace_path } from './tools/index.js';

export type File_Change_Type = 'add' | 'modify' | 'delete';

export interface File_Change {
    relative_path: string;
    type: File_Change_Type;
}

function get_sandbox_directory(sandbox_id: string): string {
    return build_archive_path(sandbox_id);
}

/**
 * Parse `git diff --name-status` output into typed file changes. Exported for
 * unit testing — the status-code mapping and the skip/fallback branches are
 * pure string logic that should not require a container to exercise. Callers
 * pass `--no-renames` (see diff_sandbox), so rename rows arrive as a delete of
 * the old path plus an add of the new path rather than a three-field `R` row.
 */
export function parse_name_status(output: string): File_Change[] {
    const changes: File_Change[] = [];
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }

        const tab_index = trimmed.indexOf('\t');
        if (tab_index === -1) {
            continue;
        }

        const status = trimmed.slice(0, tab_index);
        const file_path = trimmed.slice(tab_index + 1);

        let type: File_Change_Type;
        switch (status) {
            case 'A': type = 'add'; break;
            case 'M': type = 'modify'; break;
            case 'D': type = 'delete'; break;
            default: type = 'modify'; break;
        }
        changes.push({ relative_path: file_path, type });
    }

    return changes;
}

/** Compare sandbox working directory against git baseline, returning all file changes. */
export function diff_sandbox(sandbox_id: string): File_Change[] {
    const sandbox_directory = get_sandbox_directory(sandbox_id);
    const manifest = read_manifest(sandbox_directory);
    const name = manifest.container_name;
    const tool_name = resolve_manifest_tool(manifest);
    const provider = get_provider(tool_name);
    const cwd = compute_container_workspace_path(provider);

    // Stage everything so new files are included in the diff
    exec_container(name, ['git', 'add', '-A'], { cwd });

    // Get changes vs baseline. `--no-renames` is load-bearing: without it,
    // git emits rename status as `R<score>\told\tnew` (three tab-separated
    // fields, not two) which `parse_name_status` would silently treat as
    // a single `'modify'` of an `old\tnew` path with an embedded tab. By
    // disabling rename detection, the same change surfaces as a
    // `'delete'` of the old name plus an `'add'` of the new name — a shape
    // the parser and downstream consumers (patch/apply, CLI display)
    // handle cleanly. Patches lose nothing: git apply reconstructs the
    // rename from the delete+add pair when similarity is high.
    //
    // `-c core.quotePath=false` suppresses C-quoted octal escapes for paths
    // containing bytes ≥ 0x80, so `parse_name_status` always receives the
    // raw path bytes rather than a quoted mangled form.
    let output: string;
    try {
        output = exec_container(
            name,
            ['git', '-c', 'core.quotePath=false', 'diff', '--cached', '--name-status', '--no-renames', 'HEAD'],
            { cwd }
        );
    } finally {
        // Unstage to preserve working tree state. Best-effort: a container
        // stop between the add and the diff would make `git reset` fail too,
        // but there is nothing useful to do in that case beyond letting the
        // original error propagate.
        try {
            exec_container(name, ['git', 'reset'], { cwd });
        } catch (_reset_failed) {
            /* best-effort */
        }
    }

    return parse_name_status(output);
}
