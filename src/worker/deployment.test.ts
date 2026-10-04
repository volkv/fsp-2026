// The worker service of compose.yaml and of the production compose runs every registered handler and nothing else: a
// handler left out of `--types` never runs on the stand, a type without a handler stops the worker at start. The
// embedder service serves the model file, the input limit and the name of the embedding space the application uses.
// The models behind the reverse tunnel are reachable from the app and the worker only, and the tunnel publishes nothing:
// its client comes in through `docker exec` on the server. On the stand only the services Caddy reaches share its
// network with other projects, every network of the stand itself is internal, the services that call outside have a
// network of their own for it, and Redis takes the password of the stand's environment.
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { BGE_M3_Q8 } from '$lib/server/embeddings/definitions';
import { E2E_SLOTS } from '../../tests/e2e/helpers/ports';
import { EMBEDDER_IMAGE } from '../../tests/helpers/images';
import { parseWorkerArgs } from './args';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { JOB_HANDLERS, SCHEDULE_TICKS } = await import('$lib/server/jobs/handlers');
const { JOB_TYPES } = await import('$lib/server/jobs/registry');
const { PERIODIC_JOBS } = await import('$lib/server/jobs/scheduler');

const registeredTypes = () => Object.keys(JOB_TYPES).sort();

describe('worker deployment', () => {
	it('has a handler for every registered job type and no other', () => {
		expect([...JOB_HANDLERS.keys()].sort()).toEqual(registeredTypes());
	});

	it('has a handler for every periodic job and every schedule tick', () => {
		for (const entry of PERIODIC_JOBS) expect(JOB_HANDLERS.has(entry.type), entry.type).toBe(true);
		for (const tick of SCHEDULE_TICKS) expect(JOB_HANDLERS.has(tick.type), tick.type).toBe(true);
	});

	it.each(['compose.yaml', 'docker-compose.prod.yml'])(
		'%s enables every registered job type, each in one worker',
		async (file) => {
			const compose = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
			const argumentsOfWorkers = [...compose.matchAll(/^\s+- '(--types=[^']+)'$/gm)].map((match) => match[1] ?? '');
			if (argumentsOfWorkers.length === 0) throw new Error(`${file} has no --types argument of a worker`);
			const enabled = argumentsOfWorkers.flatMap((argument) => [...parseWorkerArgs([argument]).types]);
			expect([...enabled].sort()).toEqual(registeredTypes());
		}
	);

	it.each(['compose.yaml', 'docker-compose.prod.yml'])(
		'%s runs the embedder of the configured embedding space',
		async (file) => {
			const compose = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
			const service = /^ {2}embedder:\n([\s\S]*?)^\n/m.exec(compose)?.[1];
			if (service === undefined) throw new Error(`${file} has no embedder service`);
			expect(service).toContain(`image: ${EMBEDDER_IMAGE}\n`);
			expect(service).toContain(`MODEL_SHA256: ${BGE_M3_Q8.modelRevision}\n`);
			expect(service).toContain(`--alias ${BGE_M3_Q8.modelName} `);
			expect(service).toContain(`--pooling ${BGE_M3_Q8.pooling} `);
			for (const flag of ['--ctx-size', '--batch-size', '--ubatch-size']) {
				expect(service).toContain(`${flag} ${BGE_M3_Q8.maxInputTokens} `);
			}
			const embedModel = /^\s+EMBED_MODEL: (?:\$\{EMBED_MODEL:-)?([^}\s]+)\}?$/m.exec(compose)?.[1];
			const embedSpace = /^\s+EMBED_SPACE_ID: (?:\$\{EMBED_SPACE_ID:-)?([^}\s]+)\}?$/m.exec(compose)?.[1];
			expect(embedModel).toBe(BGE_M3_Q8.modelName);
			expect(embedSpace).toBe(BGE_M3_Q8.id);
		}
	);

	it('publishes no port of the embedder on the stand', async () => {
		const compose = await readFile(new URL('../../docker-compose.prod.yml', import.meta.url), 'utf8');
		const service = /^ {2}embedder:\n([\s\S]*?)^\n/m.exec(compose)?.[1];
		expect(service).toBeDefined();
		expect(service).not.toMatch(/^\s+ports:/m);
		expect(service).toMatch(/^\s+networks: \[internal, egress\]$/m);
	});

	it.each(['compose.yaml', 'docker-compose.prod.yml'])(
		'%s gives the bootstrap administrator to the app only, never to the worker',
		async (file) => {
			const compose = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
			const block = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[a-z][\\w-]*:$|^\\S)`, 'm');
			const app = block('app').exec(compose)?.[1];
			const worker = block('worker').exec(compose)?.[1];
			const shared = /^x-app-environment: &app-environment\n([\s\S]*?)^\S/m.exec(compose)?.[1];
			if (app === undefined || worker === undefined || shared === undefined) {
				throw new Error(`${file} has no app, worker or shared environment`);
			}
			for (const name of ['BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD']) {
				expect(app).toMatch(new RegExp(`^ {6}${name}: \\$\\{${name}:-\\}$`, 'm'));
				expect(worker).not.toContain(name);
				expect(shared).not.toContain(name);
			}
			expect(app).toMatch(/^ {6}<<: \*app-environment$/m);
		}
	);

	const read = (file: string) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

	/** Blocks of the production compose's services by name, from `services:` to the top-level `networks:`. */
	async function prodServices(): Promise<Map<string, string>> {
		const compose = await read('docker-compose.prod.yml');
		const section = /^services:\n([\s\S]*?)^networks:$/m.exec(compose)?.[1];
		if (section === undefined) throw new Error('docker-compose.prod.yml has no services section');
		const services = new Map<string, string>();
		for (const block of section.split(/^ {2}(?=[a-z][\w-]*:$)/m).slice(1)) {
			services.set(block.slice(0, block.indexOf(':')), block);
		}
		return services;
	}

	/** Blocks of the production compose's top-level networks by name, comment lines left out. */
	async function prodNetworks(): Promise<Map<string, string>> {
		const compose = await read('docker-compose.prod.yml');
		const section = /^networks:\n([\s\S]*?)^\S/m.exec(compose)?.[1];
		if (section === undefined) throw new Error('docker-compose.prod.yml has no networks section');
		const settings = section.replace(/^ *#.*\n/gm, '');
		const networks = new Map<string, string>();
		for (const block of settings.split(/^ {2}(?=[a-z][\w-]*:$)/m).slice(1)) {
			networks.set(block.slice(0, block.indexOf(':')), block);
		}
		return networks;
	}

	const networksOf = (service: string): string[] => {
		const list = /^ {4}networks: \[([^\]]*)\]$/m.exec(service)?.[1];
		return list === undefined ? [] : list.split(',').map((name) => name.trim());
	};

	const servicesOn = async (network: string): Promise<string[]> =>
		[...(await prodServices())]
			.filter(([, block]) => networksOf(block).includes(network))
			.map(([name]) => name)
			.sort();

	it('lets the local FSP simulator return to the e2e server of every slot', async () => {
		const compose = await read('compose.yaml');
		const uris = /^ {6}FSP_MOCK_REDIRECT_URIS: (.+)$/m.exec(compose)?.[1]?.split(',') ?? [];
		for (const port of E2E_SLOTS) {
			for (const host of ['localhost', '127.0.0.1']) {
				expect(uris).toContain(`http://${host}:${port}/auth/fsp/callback`);
			}
		}
	});

	describe('networks of the stand', () => {
		it('shares the network of Caddy with other projects through the app and the FSP simulator only', async () => {
			expect(await servicesOn('proxy')).toEqual(['app', 'fsp-mock']);
			expect((await prodNetworks()).get('proxy')).toMatch(/^ {4}external: true$/m);
		});

		it('keeps every network of the stand internal except the one out of the server', async () => {
			const networks = await prodNetworks();
			expect([...networks.keys()]).toContain('internal');
			for (const [name, block] of networks) {
				if (name === 'proxy' || name === 'egress') continue;
				expect(block, name).toMatch(/^ {4}internal: true$/m);
			}
			expect(networks.get('egress')).not.toMatch(/^ {4}internal:/m);
		});

		it('lets out of the server only the app, the worker and the embedder', async () => {
			expect(await servicesOn('egress')).toEqual(['app', 'embedder', 'worker']);
		});

		it('attaches every service to networks the file declares', async () => {
			const declared = new Set((await prodNetworks()).keys());
			for (const [name, block] of await prodServices()) {
				const attached = networksOf(block);
				expect(attached.length, name).toBeGreaterThan(0);
				for (const network of attached) expect(declared.has(network), `${name}: ${network}`).toBe(true);
			}
		});
	});

	describe('Redis of the stand', () => {
		it('refuses a client without the password of the environment', async () => {
			const redis = (await prodServices()).get('redis') ?? '';
			expect(redis).toMatch(/^ {4}command: \[redis-server, --requirepass, '\$\{REDIS_PASSWORD:\?\}'\]$/m);
			expect(redis).toMatch(/^ {6}REDISCLI_AUTH: \$\{REDIS_PASSWORD:\?\}$/m);
			expect(redis).toContain("test: [CMD-SHELL, 'redis-cli ping | grep -qx PONG']");
		});

		it('gives the app and the worker the password in the URL', async () => {
			const compose = await read('docker-compose.prod.yml');
			const shared = /^x-app-environment: &app-environment\n([\s\S]*?)^\S/m.exec(compose)?.[1] ?? '';
			expect(shared).toMatch(/^ {2}REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD:\?\}@fsp-career-redis:6379$/m);
			expect(compose.match(/REDIS_URL:/g)).toHaveLength(1);
		});

		it('has the password generated for a new stand and for one without it', async () => {
			const initEnv = await read('scripts/deploy/init-env.sh');
			const template = await read('.env.prod.example');
			expect(initEnv).toMatch(/^\t\[REDIS_PASSWORD\]="\$\(hex\)"$/m);
			expect(template).toMatch(/^REDIS_PASSWORD=$/m);
		});
	});

	describe('reverse tunnel to the models', () => {
		it('keeps the network `gpu` internal and to the app, the worker and the tunnel', async () => {
			expect((await prodNetworks()).get('gpu')).toMatch(/^ {4}internal: true$/m);
			expect(await servicesOn('gpu')).toEqual(['app', 'gpu-tunnel', 'worker']);
		});

		it('publishes no port of the stand and keeps the tunnel on `gpu` only', async () => {
			const services = await prodServices();
			const published = [...services].filter(([, block]) => /^ {4}ports:/m.test(block)).map(([name]) => name);
			expect(published).toEqual([]);
			const tunnel = services.get('gpu-tunnel') ?? '';
			expect(networksOf(tunnel)).toEqual(['gpu']);
			expect(tunnel).toMatch(/^ {4}read_only: true$/m);
			expect(tunnel).toMatch(/^ {4}cap_drop: \[ALL\]$/m);
			expect(tunnel).toContain('      - no-new-privileges:true\n');
			expect(tunnel).toContain('      - ./gpu-tunnel:/keys:ro\n');
			expect(tunnel).not.toMatch(/^ {4}depends_on:/m);
			for (const name of ['app', 'worker']) {
				expect(services.get(name)).not.toMatch(/^ {6}gpu-tunnel:$/m);
			}
		});

		it('holds each process of the stand to half of the runtime concurrency docs/models.md allows', async () => {
			const compose = await read('docker-compose.prod.yml');
			expect(compose).toMatch(/^ {2}LLM_MAX_CONCURRENCY: \$\{LLM_MAX_CONCURRENCY:-4\}$/m);
		});

		it('gives the tunnel account one uid in the image, the key directory and the tmpfs', async () => {
			const dockerfile = await read('infra/gpu-tunnel/Dockerfile');
			const initEnv = await read('scripts/deploy/init-env.sh');
			const services = await prodServices();
			const uid = /adduser .*-u (\d+) /.exec(dockerfile)?.[1];
			expect(uid).toBeDefined();
			expect(dockerfile).toContain(`USER ${uid}:${uid}\n`);
			expect(initEnv).toContain(`tunnel_uid=${uid}\n`);
			expect(services.get('gpu-tunnel')).toContain(`/run/tunnel:size=1m,uid=${uid},gid=${uid},mode=0700`);
		});

		it('lets the tunnel account forward the model ports and nothing else', async () => {
			const sshd = await read('infra/gpu-tunnel/sshd_config');
			const entrypoint = await read('infra/gpu-tunnel/entrypoint.sh');
			const setting = (name: string) => new RegExp(`^${name} (.+)$`, 'm').exec(sshd)?.[1];
			expect(setting('AllowTcpForwarding')).toBe('remote');
			expect(setting('PermitOpen')).toBe('none');
			expect(setting('AllowStreamLocalForwarding')).toBe('no');
			expect(setting('AllowAgentForwarding')).toBe('no');
			expect(setting('X11Forwarding')).toBe('no');
			expect(setting('PermitTunnel')).toBe('no');
			expect(setting('PermitTTY')).toBe('no');
			expect(setting('MaxSessions')).toBe('0');
			expect(setting('ForceCommand')).toBe('/bin/false');
			expect(setting('PermitListen')).toBe('57810 57801');
			expect(setting('ListenAddress')).toBe('127.0.0.1');
			const keyListens = [...entrypoint.matchAll(/permitlisten="(\d+)"/g)].map((match) => match[1]);
			expect(keyListens).toEqual(['57810', '57801']);
			expect(entrypoint).toContain("printf 'restrict,port-forwarding,permitlisten=");
		});
	});
});
