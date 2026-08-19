import { beforeAll } from 'vitest';
import { assert_required_container_runtime } from '../../src/container_runtime/required_runtime.js';

beforeAll(() => {
    assert_required_container_runtime();
});
