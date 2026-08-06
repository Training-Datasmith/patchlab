import type { Sandbox_Info } from './sandbox/index.js';

/**
 * Render a single `patchlab list` row. Multi-source patchlabs append a
 * `(+N more)` suffix after the primary source's host_path, where N is
 * `manifest.sources.length - 1` (additional SOURCES, not additional
 * repositories — same-repository multi-source and cross-repository
 * multi-source both render the suffix at their respective counts).
 */
export function format_list_header(): string {
    return 'ID  CONTAINER  STATUS  SOURCE  CREATED';
}

export function format_list_row(sandbox: Sandbox_Info): string {
    const additional_suffix = sandbox.additional_source_count > 0
        ? ` (+${sandbox.additional_source_count} more)`
        : '';
    return `${sandbox.id}  ${sandbox.container_name}  [${sandbox.container_status}]  ${sandbox.source_path}${additional_suffix}  ${sandbox.created_at}`;
}