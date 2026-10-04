import { fail } from '@sveltejs/kit';
import { standChangesLocked } from '$lib/server/access/demo-actor';
import { db } from '$lib/server/db';
import { docparse } from '$lib/server/documents/docparse';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { batchHistory, importBatch, previewBatch, type BatchDeps } from '$lib/server/fsp/import/batches';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { pageError } from '$lib/server/http/page';
import { operatorRequest } from '$lib/server/operator/http';
import { objectStore } from '$lib/server/storage/object-store';
import type { Actions, PageServerLoad } from './$types';

function batchDeps(): BatchDeps {
	return {
		db: db(),
		store: objectStore(),
		parser: docparse,
		signer: configuredReceiptSigner,
		now: () => new Date()
	};
}

/**
 * A refusal of the batch form with every detail: a profile may have many problems at once, and each is shown next to
 * the field it concerns. Only refusals the service states are shown; anything else is a server error.
 */
function batchFailure(stage: 'preview' | 'import', cause: unknown) {
	if (!(cause instanceof ApiError) || cause.code === 'internal') throw cause;
	const details: ErrorDetail[] = cause.details ?? [];
	return fail(cause.status, { stage, problem: { message: cause.message, code: cause.code, details } });
}

export const load: PageServerLoad = async (event) => {
	const { subject } = await operatorRequest(event);
	try {
		return { history: await batchHistory(db(), subject), demoLocked: await standChangesLocked(db(), subject) };
	} catch (cause) {
		pageError(event, cause);
	}
};

export const actions: Actions = {
	preview: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			return {
				stage: 'preview' as const,
				preview: await previewBatch(batchDeps(), { subject, meta }, await event.request.formData())
			};
		} catch (cause) {
			return batchFailure('preview', cause);
		}
	},
	import: async (event) => {
		const { subject, meta } = await operatorRequest(event);
		try {
			return {
				stage: 'import' as const,
				imported: await importBatch(batchDeps(), { subject, meta }, await event.request.formData())
			};
		} catch (cause) {
			return batchFailure('import', cause);
		}
	}
};
