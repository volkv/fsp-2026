// The FSP simulator `services/fsp-mock` run as a process for integration tests: a free port, the credentials the
// platform side uses, the control endpoints and a clean stop.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const MOCK_MAIN = fileURLToPath(new URL('../../services/fsp-mock/src/main.ts', import.meta.url));

/** Credentials shared by the simulator and the platform side of a test. */
export const FSP_MOCK_CREDENTIALS = {
	clientId: 'fsp-career-test',
	clientSecret: 'test-client-secret-0123456789abcdef',
	assertionSecret: 'test-assertion-secret-0123456789abcdef',
	webhookSecret: 'test-webhook-secret-0123456789abcdefgh',
	controlToken: 'test-control-token-0123456789abcdef'
} as const;

export interface FspMock {
	origin: string;
	/** Issuer of the simulated FSP ID. */
	issuer: string;
	/** Calls a control endpoint `/mock/{path}`. */
	control(method: string, path: string, body?: unknown): Promise<Response>;
	/** fspId of a demo athlete by its title. */
	heroId(title: string): Promise<string>;
	stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => {
				if (address && typeof address === 'object') resolve(address.port);
				else reject(new Error('no port'));
			});
		});
	});
}

async function waitForHealth(process: ChildProcess, origin: string, log: readonly string[]): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`fsp-mock exited: ${log.join('')}`);
		try {
			const response = await fetch(`${origin}/health`);
			if (response.ok) return;
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`fsp-mock did not become healthy: ${log.join('')}`);
}

/**
 * Starts the simulator and waits until it is healthy. Without `webhookUrl` it delivers no webhooks: the test enqueues
 * every sync itself. `redirectUri` — the FSP ID callback of an application the browser signs in to; without it the
 * simulator accepts an address nobody listens at, where a test stops the browser itself.
 */
export async function startFspMock(
	options: { webhookUrl?: string; athletes?: number; redirectUri?: string } = {}
): Promise<FspMock> {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const log: string[] = [];
	const credentials = FSP_MOCK_CREDENTIALS;
	const child = spawn(process.execPath, [MOCK_MAIN], {
		env: {
			PATH: process.env.PATH ?? '',
			FSP_MOCK_ORIGIN: origin,
			PORT: String(port),
			HOST: '127.0.0.1',
			FSP_MOCK_CLIENT_ID: credentials.clientId,
			FSP_MOCK_CLIENT_SECRET: credentials.clientSecret,
			FSP_MOCK_REDIRECT_URIS: options.redirectUri ?? 'http://127.0.0.1:1/auth/fsp/callback',
			FSP_MOCK_ASSERTION_SECRET: credentials.assertionSecret,
			FSP_MOCK_CONTROL_TOKEN: credentials.controlToken,
			FSP_MOCK_ATHLETES: String(options.athletes ?? 200),
			...(options.webhookUrl
				? { FSP_MOCK_WEBHOOK_URL: options.webhookUrl, FSP_MOCK_WEBHOOK_SECRET: credentials.webhookSecret }
				: {})
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout.on('data', (chunk: Buffer) => log.push(chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => log.push(chunk.toString('utf8')));
	await waitForHealth(child, origin, log);

	const control = (method: string, path: string, body?: unknown) =>
		fetch(`${origin}/mock/${path}`, {
			method,
			headers: {
				authorization: `Bearer ${credentials.controlToken}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});

	return {
		origin,
		issuer: `${origin}/realms/fsp`,
		control,
		heroId: async (title) => {
			const response = await control('GET', 'accounts');
			const { items } = (await response.json()) as { items: { sub: string; title: string }[] };
			const found = items.find((item) => item.title === title);
			if (!found) throw new Error(`no demo athlete «${title}»`);
			return found.sub;
		},
		stop: async () => {
			if (child.exitCode !== null) return;
			const exited = new Promise((resolve) => child.once('exit', resolve));
			child.kill('SIGTERM');
			await exited;
		}
	};
}
