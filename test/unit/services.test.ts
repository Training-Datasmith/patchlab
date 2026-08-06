import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SERVICE_MAP, match_containers_for_service, resolve_services } from '../../src/services.js';
import type { Detected_Requirements } from '../../src/detect/index.js';
import type { Running_Container } from '../../src/prompts.js';
import { make_fake_prompter } from '../helpers/fake_prompter.js';

// Task 6.3: Service-to-environment-variable mapping table
describe('service mapping table', () => {
    it('maps postgres to DATABASE_URL', () => {
        expect(SERVICE_MAP.postgres.environment_key).toBe('DATABASE_URL');
    });

    it('maps redis to REDIS_URL', () => {
        expect(SERVICE_MAP.redis.environment_key).toBe('REDIS_URL');
    });

    it('maps mysql to DATABASE_URL', () => {
        expect(SERVICE_MAP.mysql.environment_key).toBe('DATABASE_URL');
    });

    it('maps mongodb to MONGODB_URI', () => {
        expect(SERVICE_MAP.mongodb.environment_key).toBe('MONGODB_URI');
    });

    it('has connection templates with {port} placeholder', () => {
        for (const [, mapping] of Object.entries(SERVICE_MAP)) {
            expect(mapping.connection_template).toContain('{port}');
        }
    });
});

// Task 6.4: Running container query and service-to-image matching
describe('service-to-image matching', () => {
    const running: Running_Container[] = [
        { name: 'my-pg', image: 'postgres:16-alpine', ports: '0.0.0.0:5432->5432/tcp' },
        { name: 'my-redis', image: 'redis:7', ports: '0.0.0.0:6379->6379/tcp' },
        { name: 'my-app', image: 'node:22-slim', ports: 'none' },
        { name: 'pg-backup', image: 'postgres:15', ports: '0.0.0.0:5433->5432/tcp' },
        { name: 'registry-pg', image: 'registry.example.com/postgres:14', ports: '0.0.0.0:5434->5432/tcp' },
    ];

    it('matches postgres containers ignoring tag', () => {
        const matches = match_containers_for_service('postgres', running);
        expect(matches).toHaveLength(3);
        expect(matches.map((c) => c.name)).toEqual(['my-pg', 'pg-backup', 'registry-pg']);
    });

    it('matches redis containers', () => {
        const matches = match_containers_for_service('redis', running);
        expect(matches).toHaveLength(1);
        expect(matches[0].name).toBe('my-redis');
    });

    it('returns empty for unmatched service', () => {
        const matches = match_containers_for_service('mysql', running);
        expect(matches).toHaveLength(0);
    });

    it('ignores non-matching images', () => {
        const matches = match_containers_for_service('node', running);
        expect(matches).toHaveLength(1);
        expect(matches[0].name).toBe('my-app');
    });
});

// Task 6.5: Service container selection prompt logic (pre-configured, candidates found, no candidates)
describe('service selection scenarios', () => {
    it('prompt_service_selection skips when .patchlab.json configures the environment variable', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-svc-'));
        try {
            fs.writeFileSync(
                path.join(temp_dir, '.patchlab.json'),
                JSON.stringify({
                    requirements: { environment_variables: { DATABASE_URL: 'postgres://preset/db' } },
                }),
            );
            const { prompt_service_selection } = await import('../../src/prompts.js');
            const result = await prompt_service_selection(
                temp_dir,
                'postgres',
                'DATABASE_URL',
                [{ name: 'pg', image: 'postgres:16', ports: '5432' }],
                'postgres://localhost:{port}/{dbname}',
                null,
            );
            expect(result).toBeNull(); // skipped because pre-configured
        } finally {
            fs.rmSync(temp_dir, { recursive: true, force: true });
        }
    });

    it('prompt_service_selection returns null for no candidates', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-svc-'));
        try {
            const { prompt_service_selection } = await import('../../src/prompts.js');
            const result = await prompt_service_selection(
                temp_dir,
                'postgres',
                'DATABASE_URL',
                [],
                'postgres://localhost:{port}/{dbname}',
                null,
            );
            expect(result).toBeNull();
        } finally {
            fs.rmSync(temp_dir, { recursive: true, force: true });
        }
    });
});

// Prompter-driven coverage of the interactive branches of
// `prompt_service_selection`. The previous test set could not exercise
// these (they sat behind `confirm()`'s readline call); `Fake_Prompter`
// makes the policy's branches directly testable.
describe('prompt_service_selection — interactive branches via Fake_Prompter', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-svc-fake-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    const one_candidate: Running_Container[] = [
        { name: 'my-pg', image: 'postgres:16', ports: '0.0.0.0:5432->5432/tcp' },
    ];
    const multi_candidates: Running_Container[] = [
        { name: 'pg-a', image: 'postgres:16', ports: '0.0.0.0:5432->5432/tcp' },
        { name: 'pg-b', image: 'postgres:15', ports: '0.0.0.0:5433->5432/tcp' },
        { name: 'pg-c', image: 'postgres:14', ports: '0.0.0.0:5434->5432/tcp' },
    ];

    it('one-candidate: accepts AND persists when both confirms are true', async () => {
        const prompter = make_fake_prompter({ confirm: [true, true] });
        const { prompt_service_selection } = await import('../../src/prompts.js');

        const result = await prompt_service_selection(
            temporary_directory, 'postgres', 'DATABASE_URL', one_candidate,
            'postgres://localhost:{port}/{dbname}', prompter,
        );

        expect(result).not.toBeNull();
        expect(result?.environment_key).toBe('DATABASE_URL');
        expect(result?.environment_value).toBe('postgres://localhost:5432/test');
        // .patchlab.json persists the selection
        const persisted = JSON.parse(fs.readFileSync(path.join(temporary_directory, '.patchlab.json'), 'utf-8'));
        expect(persisted.requirements.environment_variables.DATABASE_URL).toBe('postgres://localhost:5432/test');
    });

    it('one-candidate: accepts but SKIPS persistence when save offer is declined', async () => {
        const prompter = make_fake_prompter({ confirm: [true, false] });
        const { prompt_service_selection } = await import('../../src/prompts.js');

        const result = await prompt_service_selection(
            temporary_directory, 'postgres', 'DATABASE_URL', one_candidate,
            'postgres://localhost:{port}/{dbname}', prompter,
        );

        expect(result).not.toBeNull();
        expect(fs.existsSync(path.join(temporary_directory, '.patchlab.json'))).toBe(false);
    });

    it('one-candidate: returns null when user declines the offer', async () => {
        // Decline → no save prompt. Queue exactly one answer; a regression
        // adding a second confirm would throw Prompter_Exhausted.
        const prompter = make_fake_prompter({ confirm: [false] });
        const { prompt_service_selection } = await import('../../src/prompts.js');

        const result = await prompt_service_selection(
            temporary_directory, 'postgres', 'DATABASE_URL', one_candidate,
            'postgres://localhost:{port}/{dbname}', prompter,
        );

        expect(result).toBeNull();
        expect(fs.existsSync(path.join(temporary_directory, '.patchlab.json'))).toBe(false);
    });

    it('multi-candidate: selects the chosen index AND persists when save is accepted', async () => {
        // Select index 1 (pg-b on port 5433); accept save.
        const prompter = make_fake_prompter({
            choose: [1],
            confirm: [true],
        });
        const { prompt_service_selection } = await import('../../src/prompts.js');

        const result = await prompt_service_selection(
            temporary_directory, 'postgres', 'DATABASE_URL', multi_candidates,
            'postgres://localhost:{port}/{dbname}', prompter,
        );

        expect(result).not.toBeNull();
        expect(result?.environment_value).toBe('postgres://localhost:5433/test');
        const persisted = JSON.parse(fs.readFileSync(path.join(temporary_directory, '.patchlab.json'), 'utf-8'));
        expect(persisted.requirements.environment_variables.DATABASE_URL).toBe('postgres://localhost:5433/test');
    });

    it('multi-candidate: selects but SKIPS persistence when save is declined', async () => {
        const prompter = make_fake_prompter({
            choose: [0],
            confirm: [false],
        });
        const { prompt_service_selection } = await import('../../src/prompts.js');

        const result = await prompt_service_selection(
            temporary_directory, 'postgres', 'DATABASE_URL', multi_candidates,
            'postgres://localhost:{port}/{dbname}', prompter,
        );

        expect(result?.environment_value).toBe('postgres://localhost:5432/test');
        expect(fs.existsSync(path.join(temporary_directory, '.patchlab.json'))).toBe(false);
    });

    it('multi-candidate: returns null when choose resolves to null (user declined / out-of-range)', async () => {
        // The prompter's `choose` may return null for any non-selection
        // outcome (out-of-range input, EOF, empty). Policy must collapse
        // to "no selection," NOT propagate the raw value.
        const prompter = make_fake_prompter({ choose: [null] });
        const { prompt_service_selection } = await import('../../src/prompts.js');

        const result = await prompt_service_selection(
            temporary_directory, 'postgres', 'DATABASE_URL', multi_candidates,
            'postgres://localhost:{port}/{dbname}', prompter,
        );

        expect(result).toBeNull();
        // No save offer was issued — a regression that confirmed-then-saved
        // on a null choose would consume from the confirm queue and surface
        // via Prompter_Exhausted on the next assertion that needs a confirm.
    });
});

describe('resolve_services — orchestration (via running_containers seam)', () => {
    let project_directory: string;

    function make_requirements(services: Detected_Requirements['services']): Detected_Requirements {
        return {
            system_packages: [],
            volume_mounts: [],
            environment_variables: [],
            services,
            npm_packages: [],
        };
    }

    function make_temp_project(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-svc-resolve-'));
    }

    function clean_up(directory: string): void {
        fs.rmSync(directory, { recursive: true, force: true });
    }

    it('returns an empty list when no service requirements are detected', async () => {
        project_directory = make_temp_project();
        try {
            const selections = await resolve_services(
                project_directory,
                make_requirements([]),
                null,
                { running_containers: [] },
            );
            expect(selections).toEqual([]);
        } finally {
            clean_up(project_directory);
        }
    });

    it('skips services whose name is not in SERVICE_MAP', async () => {
        project_directory = make_temp_project();
        try {
            const selections = await resolve_services(
                project_directory,
                make_requirements([
                    { type: 'service', name: 'cassandra', source: 'docker_compose' },
                ]),
                null,
                { running_containers: [] },
            );
            expect(selections).toEqual([]);
        } finally {
            clean_up(project_directory);
        }
    });

    it('returns no selection when a known service has no matching running container', async () => {
        project_directory = make_temp_project();
        try {
            const selections = await resolve_services(
                project_directory,
                make_requirements([
                    { type: 'service', name: 'postgres', source: 'docker_compose' },
                ]),
                null,
                { running_containers: [{ name: 'unrelated', image: 'nginx:latest', ports: '80' }] },
            );
            expect(selections).toEqual([]);
        } finally {
            clean_up(project_directory);
        }
    });

    it('short-circuits without prompting when .patchlab.json already configures the service env var', async () => {
        project_directory = make_temp_project();
        try {
            fs.writeFileSync(
                path.join(project_directory, '.patchlab.json'),
                JSON.stringify({
                    requirements: { environment_variables: { DATABASE_URL: 'postgres://preset/db' } },
                }),
            );
            // Even with a matching candidate, prompt_service_selection short-circuits
            // on the pre-configured check and resolve_services records no selection.
            const selections = await resolve_services(
                project_directory,
                make_requirements([
                    { type: 'service', name: 'postgres', source: 'docker_compose' },
                ]),
                null,
                { running_containers: [{ name: 'pg', image: 'postgres:16', ports: '5432:5432' }] },
            );
            expect(selections).toEqual([]);
        } finally {
            clean_up(project_directory);
        }
    });
});

// Task 6.6: Environment variable precedence
describe('environment variable precedence', () => {
    it('merge_service_selections overrides detected environment variables', async () => {
        const { merge_service_selections } = await import('../../src/services.js');
        const requirements = {
            system_packages: [],
            volume_mounts: [],
            environment_variables: [
                { type: 'environment_var' as const, key: 'DATABASE_URL', value: 'postgres://ci/test', source: 'ci_configuration' as const },
            ],
            services: [],
            npm_packages: [],
        };
        const selections = [{ environment_key: 'DATABASE_URL', environment_value: 'postgres://localhost:5433/test' }];
        const result = merge_service_selections(requirements, selections);
        const db = result.environment_variables.find((requirement) => requirement.key === 'DATABASE_URL');
        expect(db?.value).toBe('postgres://localhost:5433/test');
    });
});
