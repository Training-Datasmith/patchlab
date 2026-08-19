/**
 * Detached host-side TCP proxy daemon for local model endpoints.
 *
 * Spawned by `local_model_proxy/manager.ts` — not exposed as a CLI subcommand.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger.js';
import {
    start_proxy_listeners,
    type Proxy_Forward,
} from './proxy.js';

interface Daemon_Arguments {
    metadata_path: string;
    bind_address: string;
    allowed_client_prefixes: readonly string[];
    forwards: { target_port: number }[];
}

function parse_arguments(argv: string[]): Daemon_Arguments {
    let metadata_path = '';
    let bind_address = '127.0.0.1';
    let allowed_client_prefixes_json = '[]';
    let forwards_json = '[]';

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--metadata-path') {
            metadata_path = argv[++index] ?? '';
        } else if (argument === '--bind-address') {
            bind_address = argv[++index] ?? bind_address;
        } else if (argument === '--allowed-client-prefixes') {
            allowed_client_prefixes_json = argv[++index] ?? allowed_client_prefixes_json;
        } else if (argument === '--forwards') {
            forwards_json = argv[++index] ?? forwards_json;
        }
    }

    if (metadata_path === '') {
        throw new Error('Missing --metadata-path');
    }

    const forwards = JSON.parse(forwards_json) as { target_port: number }[];
    const allowed_client_prefixes = JSON.parse(allowed_client_prefixes_json) as string[];
    return { metadata_path, bind_address, allowed_client_prefixes, forwards };
}

async function run_daemon(): Promise<void> {
    const args = parse_arguments(process.argv.slice(2));
    const { bind_address, listen_ports, servers } = await start_proxy_listeners(
        args.bind_address,
        args.forwards,
        { allowed_client_prefixes: args.allowed_client_prefixes },
    );

    const metadata_forwards: Proxy_Forward[] = args.forwards.map((forward) => ({
        target_port: forward.target_port,
        listen_port: listen_ports.get(forward.target_port) ?? forward.target_port,
    }));

    const metadata = {
        pid: process.pid,
        forwards: metadata_forwards,
        bind_address,
    };

    fs.writeFileSync(args.metadata_path, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');

    const shutdown = (): void => {
        for (const server of servers) {
            server.close();
        }
        process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

const invoked = process.argv[1] ?? '';
if (path.basename(invoked) === 'main.js') {
    run_daemon().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger().error(message);
        process.exit(1);
    });
}
