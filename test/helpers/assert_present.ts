/**
 * Narrowing assertion for test code: throws when the value is `null` or
 * `undefined`, and tells TypeScript that subsequent reads can treat it as
 * present. Used in place of the `!` non-null assertion operator so the
 * load-bearing assumption is visible in the test output if it ever fails.
 */
export function assert_present<T>(
    value: T | null | undefined,
    message?: string,
): asserts value is T {
    if (value === null || value === undefined) {
        throw new Error(message ?? 'expected value to be present, got null/undefined');
    }
}
