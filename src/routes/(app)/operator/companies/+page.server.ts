import { verificationQueue, type AuthorityMethod } from '$lib/server/companies/verification';
import type { RegistryCheckState } from '$lib/server/companies/registry-check';
import { db } from '$lib/server/db';
import { companyDeps } from '$lib/server/employer/http';
import { pageError } from '$lib/server/http/page';
import { companyDirectory, parseCompanyStatus } from '$lib/server/operator/companies';
import { operatorRequest } from '$lib/server/operator/http';
import type { PageServerLoad } from './$types';

const METHODS: readonly AuthorityMethod[] = [
	'director_self',
	'power_of_attorney',
	'corporate_email_domain',
	'signed_letter',
	'esign'
];
const REGISTRY: readonly RegistryCheckState[] = ['found', 'not_found', 'unavailable', 'not_configured', 'pending'];

export const load: PageServerLoad = async (event) => {
	const { subject, meta } = await operatorRequest(event);
	const params = event.url.searchParams;
	const method = METHODS.find((value) => value === params.get('method')) ?? null;
	const registry = REGISTRY.find((value) => value === params.get('registry')) ?? null;
	const overdueOnly = params.get('overdue') === '1';
	const cursor = params.get('cursor') ?? undefined;
	const status = parseCompanyStatus(params.get('status'));
	const q = params.get('q') ?? '';
	try {
		const queue = await verificationQueue(
			companyDeps(),
			{ subject, meta },
			{
				...(method ? { authorityMethods: [method] } : {}),
				...(registry ? { registry: [registry] } : {}),
				overdueOnly,
				...(cursor === undefined ? {} : { cursor })
			}
		);
		return {
			now: new Date(),
			filters: { method, registry, overdueOnly, status, q },
			queue,
			directory: await companyDirectory(db(), subject, { status, q })
		};
	} catch (cause) {
		pageError(event, cause);
	}
};
