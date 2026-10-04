// Process-wide instances of the model adapter and the mode switch, created on first use so that `vite build`
// does not need the runtime environment.
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { redis } from '$lib/server/redis';
import { ModelAdapter } from './adapter';
import { ModelModes } from './modes';
import { databaseSpaceLookup } from './spaces';

let modes: ModelModes | undefined;
let adapter: ModelAdapter | undefined;

export function modelModes(): ModelModes {
	modes ??= new ModelModes({ client: redis, database: db });
	return modes;
}

export function modelAdapter(): ModelAdapter {
	adapter ??= new ModelAdapter({
		models: config().models,
		modes: modelModes(),
		spaces: databaseSpaceLookup(db)
	});
	return adapter;
}
