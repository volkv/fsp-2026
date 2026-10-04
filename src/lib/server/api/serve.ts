// Route handlers of the public API: a route file exports `serve(operation)` for each of its methods.
import type { RequestHandler } from '@sveltejs/kit';
import { errorResponse } from '$lib/server/errors/api-error';
import { runOperation, type Operation } from './operation';
import { apiServices, type ApiServices } from './services';

export function serve(operation: Operation): RequestHandler {
	return (event) => {
		let services: ApiServices;
		try {
			services = apiServices();
		} catch (error) {
			return errorResponse(error, event.locals.requestId);
		}
		return runOperation(operation, services, event);
	};
}
