export const OPENCODE_NPM_PACKAGE = 'opencode-ai';

/** npm version baked into patchlab images; bump only after integration tests pass. */
export const OPENCODE_PINNED_VERSION = '1.18.18';

export const OPENCODE_NPM_SPEC = `${OPENCODE_NPM_PACKAGE}@${OPENCODE_PINNED_VERSION}`;

/** Extract the first semver triple from `opencode --version` output. */
export function parse_opencode_version_output(output: string): string | null {
    const match = output.trim().match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
}
