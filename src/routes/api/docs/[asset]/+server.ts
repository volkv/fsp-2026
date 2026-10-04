import { docsAsset, isDocsAsset } from '$lib/server/api/docs';
import { ApiError, errorResponse } from '$lib/server/errors/api-error';
import type { RequestHandler } from './$types';

/** Styles and scripts of the Swagger UI page, served by the application itself. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!isDocsAsset(params.asset)) return errorResponse(new ApiError('not_found'), locals.requestId);
	try {
		const asset = await docsAsset(params.asset);
		return new Response(asset.body, {
			headers: { 'content-type': asset.type, 'cache-control': 'public, max-age=3600' }
		});
	} catch (error) {
		return errorResponse(error, locals.requestId);
	}
};
