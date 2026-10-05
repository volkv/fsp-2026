import { read } from '$app/server';
import { candidateRequest } from '$lib/server/candidates/http';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { db } from '$lib/server/db';
import { configuredReceiptSigner } from '$lib/server/fsp/receipts';
import { pageError } from '$lib/server/http/page';
import regularFont from '$lib/server/profile/fonts/Inter-Regular.ttf';
import semiboldFont from '$lib/server/profile/fonts/Inter-SemiBold.ttf';
import { renderProfilePdf } from '$lib/server/profile/pdf';
import { buildProfilePdf } from '$lib/server/profile/pdf-input';
import type { RequestHandler } from './$types';

/**
 * The PDF profile of the candidate (domain 12.9), made for the candidate's own session and kept nowhere: the QR codes
 * lead to the signed confirmations of the categories, issued with the first PDF of each assignment. Which contacts go
 * on the page is the candidate's choice in the address (`phone`, `email`, `telegram`).
 */
export const GET: RequestHandler = async (event) => {
	const { subject, meta } = await candidateRequest(event);
	const chosen = (name: string) => event.url.searchParams.get(name) === 'on';
	try {
		const input = await buildProfilePdf(
			{ db: db(), crypto: fieldCrypto(), signer: configuredReceiptSigner(), now: () => new Date() },
			subject,
			meta,
			{ phone: chosen('phone'), email: chosen('email'), telegram: chosen('telegram') }
		);
		const [regular, semibold] = await Promise.all([read(regularFont).arrayBuffer(), read(semiboldFont).arrayBuffer()]);
		const pdf = await renderProfilePdf(input, { regular: new Uint8Array(regular), semibold: new Uint8Array(semibold) });
		return new Response(new Uint8Array(pdf), {
			headers: {
				'content-type': 'application/pdf',
				'content-disposition': `attachment; filename="fsp-career-profile-${new Date().toISOString().slice(0, 10)}.pdf"`,
				'cache-control': 'private, no-store'
			}
		});
	} catch (cause) {
		pageError(event, cause);
	}
};
