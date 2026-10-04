// Refusals of the services turned into SvelteKit page errors and form failures: shared by the cabinets.
import { error, fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';

/** A refusal of a service while a page loads: the page shows it with its status; anything else is a server error. */
export function pageError(event: RequestEvent, cause: unknown): never {
	if (cause instanceof ApiError && cause.code !== 'internal') {
		error(cause.status, { message: cause.message, requestId: event.locals.requestId });
	}
	throw cause;
}

export interface FormProblem {
	message: string;
	/** Messages by field path, for the fields of the form. */
	fields: Record<string, string>;
	code: string;
}

/**
 * A refusal of a service after a form post: the form shows the message and the field problems. Only refusals the
 * service states are shown; anything else is a server error.
 */
export function formFailure(cause: unknown): ActionFailure<{ problem: FormProblem }> {
	if (!(cause instanceof ApiError) || cause.code === 'internal') throw cause;
	const details: ErrorDetail[] = cause.details ?? [];
	const fields: Record<string, string> = {};
	for (const detail of details) if (detail.path !== undefined) fields[detail.path] ??= detail.message;
	const [only] = details.length === 1 ? details : [];
	return fail(cause.status, {
		problem: { message: only?.message ?? cause.message, fields, code: only?.code ?? cause.code }
	});
}
