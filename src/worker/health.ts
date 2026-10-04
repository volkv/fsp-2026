// State endpoint of the worker: `GET /health` answers 200 `ok` while the worker runs and talks to the database, 503
// `degraded` otherwise, with the counters of every enabled type. It listens on loopback only: the container's
// healthcheck and a developer on the same machine read it, nobody else.
import { createServer, type Server } from 'node:http';
import type { Worker } from '$lib/server/jobs/worker';

export function serveHealth(worker: Worker, port: number): Promise<Server> {
	const server = createServer((request, response) => {
		if (request.method !== 'GET' || request.url !== '/health') {
			response.writeHead(404).end();
			return;
		}
		const healthy = worker.healthy();
		const body = JSON.stringify({
			status: healthy ? 'ok' : 'degraded',
			version: __APP_VERSION__,
			commit: __APP_COMMIT__,
			worker: worker.metrics()
		});
		response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' }).end(body);
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			server.off('error', reject);
			resolve(server);
		});
	});
}
