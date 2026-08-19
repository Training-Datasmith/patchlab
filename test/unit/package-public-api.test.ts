/**
 * Compile-time guard: third-party Tool_Provider authors import these types
 * from the package root (`import type { ... } from 'patchlab'`).
 */
import { describe, it, expect } from 'vitest';
import type {
    Authentication_Method,
    Authentication_Result,
    Extractable_Artifact,
    Host_Access_Plan,
    Host_File_Copy,
    Image_Specification,
    Launch_Context,
    Prepare_Host_Access_Context,
    Prompt_Passthrough_Capability,
    Tool_Provider,
} from '../../src/index.js';
import { HOST_PATCHLAB_INTERNAL, register_provider } from '../../src/index.js';

function example_provider_shape(
    _method: Authentication_Method,
    _result: Authentication_Result,
    _image: Image_Specification,
    _launch: Launch_Context,
    _artifact: Extractable_Artifact,
    _plan: Host_Access_Plan,
    _copy: Host_File_Copy,
    _context: Prepare_Host_Access_Context,
    _capability: Prompt_Passthrough_Capability,
    _provider: Tool_Provider,
): void {
}

describe('package root provider API (R12)', () => {
    it('keeps compile-time exports for custom Tool_Provider implementations', () => {
        example_provider_shape(
            'none',
            { type: 'none' },
            {} as Image_Specification,
            {},
            {} as Extractable_Artifact,
            {} as Host_Access_Plan,
            {} as Host_File_Copy,
            {} as Prepare_Host_Access_Context,
            'passthrough',
            {} as Tool_Provider,
        );

        expect(typeof register_provider).toBe('function');
        expect(HOST_PATCHLAB_INTERNAL).toBe('host.patchlab.internal');
    });
});
