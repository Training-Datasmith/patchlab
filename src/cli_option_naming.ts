import { Option } from 'commander';

/**
 * Make Commander derive option attribute keys in `snake_case` (kebab → snake)
 * instead of its default `camelCase`, so the keys on a parsed options object
 * match this project's snake_case naming convention. Handlers then read
 * `options.dry_run` / `options.older_than` directly — the form they were
 * already written in — rather than Commander's `options.dryRun` / `olderThan`.
 *
 * Mechanism: Commander stores every parsed value, and keys its internal
 * positive/negative option reconciliation, by `Option.prototype.attributeName()`
 * (see node_modules/commander/lib/option.js). Overriding that single method is
 * the entire change. The default is:
 *
 *     attributeName() {
 *         return camelcase(this.negate ? this.name().replace(/^no-/, '') : this.name());
 *     }
 *
 * so we keep the same `no-` handling and only swap the kebab→case transform.
 * Single-word flags (`--force`) and negated flags (`--no-install` → `install`)
 * are unchanged either way; only multi-word flags differ (`--older-than` →
 * `older_than` instead of `olderThan`).
 *
 * CAVEAT: this monkey-patches a third-party prototype, so it applies to every
 * `Option` in the process and is invisible at the command-definition sites. It
 * must run BEFORE any command/option is registered — call it at the very top of
 * cli.ts module evaluation. The parse-through invariant test
 * (test/unit/cli-option-naming.test.ts) pins this behaviour so a Commander
 * upgrade that changes `attributeName`'s contract fails loudly rather than
 * silently reverting every option key to camelCase.
 */
export function apply_snake_case_option_naming(): void {
    Option.prototype.attributeName = function derive_attribute_name(this: Option): string {
        const long_name = this.negate ? this.name().replace(/^no-/, '') : this.name();
        return long_name.split('-').join('_');
    };
}
