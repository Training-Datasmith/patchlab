import * as path from 'node:path';
import {
    list_registrations,
    get_user_global_load_errors,
    type Provider_Source,
} from './tools/index.js';
import { format_warning, type Manifest_Parse_Error } from './tools/configured_provider/index.js';
import { logger } from './logger.js';

export function format_provider_source(source: Provider_Source): string {
    if (source.kind === 'built-in') {
        return 'built-in';
    }

    return (source.kind === 'user-global')
        ? `user-global: ${source.manifest_path}`
        : `per-source: ${source.manifest_path}`;
}

/**
 * Print registered providers (built-in + user-global + optionally per-source)
 * and inline-warn about any malformed manifest. Exported so the unit suite can
 * drive it with stubbed discovery without spinning up the full Commander
 * harness.
 *
 * Module-load already ran `register_user_global_providers({ mode:
 * 'collect-and-skip' })`; the errors it collected come in via
 * `user_global_errors` (default: read from the module-load cache) so a broken
 * user-global manifest no longer aborts the command.
 *
 * Per-source discovery only runs when the caller passes `source_path`. When
 * set, per-source manifests under `<source_path>/.patchlab/tools/` are
 * registered via the caller-supplied `register_per_source` callback, which
 * returns any `Manifest_Parse_Error`s. The annotation `[unconfirmed]` is
 * appended to per-source entries when `is_per_source_unconfirmed` returns
 * `true`. Per-source registration here is read-only and does NOT trigger the
 * trust prompt.
 */
export interface Run_List_Tools_Options {
    /**
     * Sink for listing rows. Defaults to `logger().result(line)` (stdout,
     * trailing-newline rule). Tests pass capture buffers; caller-supplied sinks
     * bypass the Logger and are unaffected by `set_logger` swaps.
     */
    output_log?: (line: string) => void;
    /**
     * Sink for inline warnings about malformed manifests. Defaults to
     * `logger().warn(line)` (stderr, trailing-newline rule). Tests pass capture
     * buffers; caller-supplied sinks bypass the Logger.
     */
    output_warn?: (line: string) => void;
    user_global_errors?: Manifest_Parse_Error[];
    source_path?: string;
    register_per_source?: (source_path: string) => Manifest_Parse_Error[];
    is_per_source_unconfirmed?: (source_path: string) => boolean;
}

export function run_list_tools(options?: Run_List_Tools_Options): void {
    const output_log = options?.output_log ?? ((line: string) => logger().result(line));
    const output_warn = options?.output_warn ?? ((line: string) => logger().warn(line));
    const user_global_errors = options?.user_global_errors ?? get_user_global_load_errors();

    let per_source_errors: Manifest_Parse_Error[] = [];
    if (options?.source_path !== undefined && options.register_per_source) {
        per_source_errors = options.register_per_source(options.source_path);
    }

    const unconfirmed = options?.source_path !== undefined && options.is_per_source_unconfirmed
        ? options.is_per_source_unconfirmed(options.source_path)
        : false;

    for (const { name, provider, source } of list_registrations()) {
        const label = format_provider_source(source);
        const annotation = source.kind === 'per-source' && unconfirmed ? ' [unconfirmed]' : '';
        output_log(`${name}  (${provider.display_name})  [${label}]${annotation}`);
    }

    for (const error of [...user_global_errors, ...per_source_errors]) {
        output_warn(format_warning({
            operation: 'list_tools',
            provider_name: path.basename(error.manifest_path),
            action: 'rejected',
            target: error.field_path === '' ? error.manifest_path : error.field_path,
            reason: error.reason,
        }));
    }
}