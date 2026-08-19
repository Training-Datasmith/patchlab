import { describe, expect, it } from 'vitest';
import { normalize_host_config } from '../../helpers/exec_runtime_cli.js';

describe('normalize_host_config', () => {
    it('passes through podman NanoCpus', () => {
        expect(normalize_host_config({
            Memory: 1024 ** 3,
            NanoCpus: 1_000_000_000,
            PidsLimit: 256,
            BlkioWeight: 500,
        })).toEqual({
            Memory: 1024 ** 3,
            NanoCpus: 1_000_000_000,
            PidsLimit: 256,
            BlkioWeight: 500,
        });
    });

    it('derives NanoCpus from nerdctl CpuQuota and CpuPeriod', () => {
        expect(normalize_host_config({
            Memory: 1073741824,
            CpuQuota: 100_000,
            CpuPeriod: 100_000,
            PidsLimit: 256,
            BlkioWeight: 500,
        })).toEqual({
            Memory: 1073741824,
            NanoCpus: 1_000_000_000,
            PidsLimit: 256,
            BlkioWeight: 500,
        });
    });
});
