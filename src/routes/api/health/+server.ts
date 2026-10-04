import { json } from '@sveltejs/kit';
import { checkHealth } from '$lib/server/health';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const report = await checkHealth();
	return json(report, {
		status: report.status === 'ok' ? 200 : 503,
		headers: { 'cache-control': 'no-store' }
	});
};
