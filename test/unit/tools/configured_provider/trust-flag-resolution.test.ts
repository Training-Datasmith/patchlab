/**
 * Tests for `resolve_trust_options_from` — combines `--strict-trust` /
 * `--allow-untrusted-manifests` CLI flag values with their env-var
 * equivalents (task 6.13).
 */
import { describe, it, expect } from 'vitest';
import {
    resolve_trust_options_from,
    Conflicting_Flags_Error,
} from '../../../../src/tools/configured_provider/trust_verification.js';

describe('resolve_trust_options_from (task 6.13)', () => {
    it('neither set → no opt-out signals', () => {
        const result = resolve_trust_options_from({ strict_trust: false, allow_untrusted: false }, {});
        expect(result.strict_trust).toBe(false);
        expect(result.allow_untrusted_manifests).toBe(false);
    });

    it('--strict-trust flag alone → strict_trust true', () => {
        const result = resolve_trust_options_from({ strict_trust: true, allow_untrusted: false }, {});
        expect(result.strict_trust).toBe(true);
        expect(result.allow_untrusted_manifests).toBe(false);
    });

    it('PATCHLAB_STRICT_TRUST=1 alone → strict_trust true', () => {
        const result = resolve_trust_options_from(
            { strict_trust: false, allow_untrusted: false },
            { PATCHLAB_STRICT_TRUST: '1' },
        );
        expect(result.strict_trust).toBe(true);
    });

    it('--allow-untrusted-manifests alone → allow_untrusted_manifests true', () => {
        const result = resolve_trust_options_from({ strict_trust: false, allow_untrusted: true }, {});
        expect(result.allow_untrusted_manifests).toBe(true);
        expect(result.strict_trust).toBe(false);
    });

    it('PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS=1 alone → allow_untrusted_manifests true', () => {
        const result = resolve_trust_options_from(
            { strict_trust: false, allow_untrusted: false },
            { PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: '1' },
        );
        expect(result.allow_untrusted_manifests).toBe(true);
    });

    it('flag set + env unset → flag value wins', () => {
        // Without strict via env, flag drives the result.
        const result = resolve_trust_options_from({ strict_trust: true, allow_untrusted: false }, {});
        expect(result.strict_trust).toBe(true);
    });

    it('flag set + env set (same axis) → still that axis true (no false-on-flag override behavior)', () => {
        const result = resolve_trust_options_from(
            { strict_trust: true, allow_untrusted: false },
            { PATCHLAB_STRICT_TRUST: '1' },
        );
        expect(result.strict_trust).toBe(true);
    });

    it('strict via flag + allow via env → Conflicting_Flags_Error', () => {
        expect(() => resolve_trust_options_from(
            { strict_trust: true, allow_untrusted: false },
            { PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: '1' },
        )).toThrow(Conflicting_Flags_Error);
    });

    it('strict via env + allow via flag → Conflicting_Flags_Error', () => {
        expect(() => resolve_trust_options_from(
            { strict_trust: false, allow_untrusted: true },
            { PATCHLAB_STRICT_TRUST: '1' },
        )).toThrow(Conflicting_Flags_Error);
    });

    it('both flags set → Conflicting_Flags_Error', () => {
        expect(() => resolve_trust_options_from(
            { strict_trust: true, allow_untrusted: true },
            {},
        )).toThrow(Conflicting_Flags_Error);
    });

    it('both env vars set → Conflicting_Flags_Error', () => {
        expect(() => resolve_trust_options_from(
            { strict_trust: false, allow_untrusted: false },
            { PATCHLAB_STRICT_TRUST: '1', PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: '1' },
        )).toThrow(Conflicting_Flags_Error);
    });

    it('env var values other than "1" are ignored', () => {
        const result = resolve_trust_options_from(
            { strict_trust: false, allow_untrusted: false },
            { PATCHLAB_STRICT_TRUST: 'true', PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: 'yes' },
        );
        expect(result.strict_trust).toBe(false);
        expect(result.allow_untrusted_manifests).toBe(false);
    });
});
