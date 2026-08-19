import { describe, it, expect, vi } from 'vitest';
import { create_integration_cleanup_registry } from '../../helpers/integration_cleanup.js';

describe('create_integration_cleanup_registry', () => {
    it('awaits async cleanup handlers in reverse registration order', async () => {
        const registry = create_integration_cleanup_registry();
        const order: string[] = [];

        registry.register(async () => {
            await Promise.resolve();
            order.push('second');
        });
        registry.register(() => {
            order.push('first');
        });

        await registry.run_all();

        expect(order).toEqual(['first', 'second']);
    });

    it('continues running handlers when one throws', async () => {
        const registry = create_integration_cleanup_registry();
        const fn = vi.fn();

        registry.register(() => {
            throw new Error('boom');
        });
        registry.register(fn);

        await registry.run_all();

        expect(fn).toHaveBeenCalledOnce();
    });
});
