import { latest_session_with_metadata, read_session_metadata } from '../archive.js';
import {
    persisted_resource_limits_from_on_disk,
    type Persisted_Resource_Limits,
} from '../resource_limits.js';
import type { Loaded_Configuration } from '../configuration.js';

/**
 * Default value used when the caller did not pass `loaded_configuration` — the
 * resolver treats both slots as `null`, falls through to runtime defaults /
 * manifest / CLI without consulting any configuration file, and emits no
 * clamp/discard/ignore verbose lines.
 */
export const EMPTY_LOADED_CONFIGURATION: Loaded_Configuration = {
    user_global: null,
    per_source: null,
};

/**
 * Read the most-recent session's persisted `resource_limits` block for the
 * given patchlab id and convert it to the in-memory resolver-input shape.
 * Returns `null` when there is no prior session, when the session predates
 * the resource-limits feature, or when no `resource_limits` block has been
 * written yet (e.g. an in-progress session that failed before the post-create
 * r-m-w). The resolver treats `null` as "no persisted layer for any field"
 * and falls through to lower-precedence sources.
 *
 * The conversion at the disk boundary translates bare on-disk keys
 * (`memory`, `cpus`, `pids`) to the `_limit`-suffixed TS field names the
 * resolver consumes.
 */
export function read_persisted_resource_limits(patchlab_id: string): Persisted_Resource_Limits | null {
    const latest_session = latest_session_with_metadata(patchlab_id);
    if (latest_session === null) {
        return null;
    }

    const previous = read_session_metadata(patchlab_id, latest_session);
    const on_disk = previous?.resource_limits ?? null;
    return on_disk === null ? null : persisted_resource_limits_from_on_disk(on_disk);
}
