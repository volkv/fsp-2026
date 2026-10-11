// Every route of `/api/v1`: the operations served by `serve()` and the webhooks served by their own modules. The
// document is generated from this list; a test checks it against the route files.
import { z } from 'zod';
import { defineOperation, type Operation } from '../operation';
import { openApiDocument, type ExternalRoute, type OpenApiDocument } from '../openapi';
import { OUTGOING_WEBHOOKS } from './event-webhooks';
import * as account from './account';
import * as applications from './applications';
import * as catalog from './catalog';
import * as categories from './categories';
import * as challenges from './challenges';
import * as companies from './companies';
import * as complaints from './complaints';
import * as events from './events';
import * as companyProfile from './company-profile';
import * as confirmations from './confirmations';
import * as consents from './consents';
import * as demand from './demand';
import * as grades from './grades';
import * as hiring from './hiring';
import * as integrations from './integrations';
import * as invitations from './invitations';
import * as me from './me';
import * as messages from './messages';
import * as needs from './needs';
import * as operator from './operator';
import * as partnerPools from './partner-pools';
import * as profile from './profile';
import * as resumes from './resumes';
import * as shortlists from './shortlists';
import * as taxonomy from './taxonomy';
import * as tests from './tests';
import * as vacancies from './vacancies';
import * as verify from './verify';

let document: OpenApiDocument | undefined;

export const getOpenApiDocument = defineOperation({
	id: 'getOpenApiDocument',
	method: 'GET',
	path: '/openapi.json',
	tag: 'Документация',
	summary: 'Документ OpenAPI',
	description: 'OpenAPI 3.1 этой версии, сгенерированный из схем маршрутов. Интерактивно — `/api/docs`.',
	auth: 'public',
	errors: [],
	response: {
		status: 200,
		description: 'Документ OpenAPI 3.1',
		schema: z.looseObject({ openapi: z.literal('3.1.0') })
	},
	handle: () => {
		document ??= openApiDocument(API_OPERATIONS, EXTERNAL_ROUTES, OUTGOING_WEBHOOKS);
		return Promise.resolve(document);
	}
});

export const API_OPERATIONS: readonly Operation[] = [
	getOpenApiDocument,
	...Object.values(taxonomy),
	...Object.values(companies),
	...Object.values(vacancies),
	...Object.values(catalog),
	...Object.values(partnerPools),
	...Object.values(me),
	...Object.values(profile),
	...Object.values(resumes),
	...Object.values(consents),
	...Object.values(account),
	...Object.values(tests),
	...Object.values(companyProfile),
	...Object.values(needs),
	...Object.values(shortlists),
	...Object.values(categories),
	...Object.values(grades),
	...Object.values(invitations),
	...Object.values(messages),
	...Object.values(hiring),
	...Object.values(verify),
	...Object.values(operator),
	...Object.values(confirmations),
	...Object.values(challenges),
	...Object.values(applications),
	...Object.values(demand),
	...Object.values(complaints),
	...Object.values(events)
];

export const EXTERNAL_ROUTES: readonly ExternalRoute[] = Object.values(integrations);
