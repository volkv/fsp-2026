import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { POSTGRES_IMAGE, REDIS_IMAGE } from '../helpers/images';

declare module 'vitest' {
	export interface ProvidedContext {
		databaseUrl: string;
		redisUrl: string;
	}
}

export default async function setup(project: TestProject) {
	const [postgres, redis] = await Promise.all([
		new PostgreSqlContainer(POSTGRES_IMAGE).start(),
		new RedisContainer(REDIS_IMAGE).start()
	]);
	project.provide('databaseUrl', postgres.getConnectionUri());
	project.provide('redisUrl', redis.getConnectionUrl());

	return async () => {
		await Promise.all([postgres.stop(), redis.stop()]);
	};
}
