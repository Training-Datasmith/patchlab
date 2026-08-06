/**
 * Dockerfile-block validators for the configured tool-provider manifest.
 *
 * The `dockerfile` block is optional. When present, it declares:
 *   - `install`: a list of RUN strings appended verbatim to the generated
 *     Dockerfile (each entry becomes its own `RUN <entry>` line)
 *   - `environment`: a string→string map appended as `ENV` directives
 *
 * Both fields default to empty when the block is present but the inner
 * field is omitted; the block itself is `undefined` when omitted entirely.
 */
import { is_plain_object } from '../../json_validators.js';
import { fail, POSIX_RESERVED_CHAR_REGEX } from './validators.js';

export function validate_dockerfile(
    raw: unknown
): { install: string[]; environment: Record<string, string> } | undefined {
    if (raw === undefined) {
        return undefined;
    }

    if (!is_plain_object(raw)) {
        fail('dockerfile', 'must be a mapping');
    }

    const block = raw as { install?: unknown; environment?: unknown; [k: string]: unknown };
    reject_unknown_dockerfile_fields(block);
    return {
        install: validate_dockerfile_install(block.install ?? []),
        environment: validate_dockerfile_environment(block.environment ?? {}),
    };
}

function validate_dockerfile_install(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        fail('dockerfile.install', 'must be a list of strings');
    }

    const install: string[] = [];
    for (const [index, entry] of raw.entries()) {
        if (typeof entry !== 'string') {
            fail(`dockerfile.install[${index}]`, 'must be a string');
        }

        if (entry.trim() === '') {
            fail(`dockerfile.install[${index}]`, 'must be a non-empty string (an empty RUN directive is invalid Dockerfile syntax)');
        }

        // Each entry is rendered verbatim as a single `RUN ${entry}` line. A
        // newline would end the RUN and let the remainder inject a separate
        // Dockerfile directive (LABEL, COPY, FROM…) that the trust prompt — which
        // lists install entries joined by ', ' — would not surface as distinct.
        // Reject newlines / control chars, exactly as the ENV-value guard does;
        // chain multiple shell steps with `&&` on one line instead.
        if (POSIX_RESERVED_CHAR_REGEX.test(entry)) {
            fail(
                `dockerfile.install[${index}]`,
                'must not contain newlines or ASCII control characters '
                + '(they would inject additional Dockerfile directives); '
                + 'chain steps with && on a single line',
            );
        }

        install.push(entry);
    }

    return install;
}

function validate_dockerfile_environment(raw: unknown): Record<string, string> {
    if (!is_plain_object(raw)) {
        fail('dockerfile.environment', 'must be a mapping of string→string');
    }

    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        validate_dockerfile_environment_key(key);
        if (typeof value !== 'string') {
            fail(`dockerfile.environment.${key}`, `value must be a string; got ${typeof value}`);
        }
        validate_dockerfile_environment_value(key, value);
        environment[key] = value;
    }

    return environment;
}

function validate_dockerfile_environment_value(key: string, value: string): void {
    // The value is interpolated verbatim into a single `ENV ${key}=${value}`
    // line (see assemble_dockerfile_text). A newline would terminate the ENV
    // directive and let the remainder of the value inject an arbitrary
    // Dockerfile instruction (e.g. a `RUN`), so reject any line break or
    // other ASCII control character. Mirrors the env-file guard in podman.ts.
    if (POSIX_RESERVED_CHAR_REGEX.test(value)) {
        fail(
            `dockerfile.environment.${key}`,
            'value must not contain newlines or ASCII control characters '
            + '(they would inject additional Dockerfile directives)',
        );
    }
}

function validate_dockerfile_environment_key(key: string): void {
    if (key === '') {
        fail('dockerfile.environment', 'keys must be non-empty');
    }
    if (key.includes('=')) {
        fail(`dockerfile.environment.${key}`, 'keys must not contain `=`');
    }
    if (POSIX_RESERVED_CHAR_REGEX.test(key)) {
        fail(`dockerfile.environment.${key}`, 'keys must not contain null bytes or ASCII control characters');
    }
}

function reject_unknown_dockerfile_fields(block: Record<string, unknown>): void {
    for (const key of Object.keys(block)) {
        if (key !== 'install' && key !== 'environment') {
            fail(`dockerfile.${key}`, 'unknown field');
        }
    }
}
