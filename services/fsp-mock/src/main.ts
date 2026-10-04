import { ConfigError, loadConfig } from './config.ts';
import { createMockApp } from './server.ts';

let config;
try {
	config = loadConfig(process.env);
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(`fsp-mock: configuration error: ${error.message}`);
		process.exit(1);
	}
	throw error;
}

const app = createMockApp(config);
const { world } = app.store;
app.server.listen(config.port, config.host, () => {
	console.log(
		`fsp-mock: issuer ${app.issuer}, listening on ${config.host}:${config.port}; dataset ${world.datasetId}: ` +
			`${world.athletes.size} athletes, ${world.competitions.size} competitions` +
			(config.controlToken ? '; control endpoints enabled' : '')
	);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		app.server.close();
		app.server.closeAllConnections();
	});
}
