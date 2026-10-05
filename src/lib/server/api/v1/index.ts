// Every route of `/api/v1`: the operations served by `serve()` and the webhooks served by their own modules. The
// document is generated from this list; a test checks it against the route files.
import { z } from 'zod';
import { defineOperation, type Operation } from '../operation';
import { openApiDocument, type ExternalRoute, type OpenApiDocument } from '../openapi';
import * as catalog from './catalog';
import * as categories from './categories';
import * as companies from './companies';
import * as companyProfile from './company-profile';
import * as grades from './grades';
import * as hiring from './hiring';
import * as integrations from './integrations';
import * as invitations from './invitations';
import * as me from './me';
import * as needs from './needs';
import * as operator from './operator';
import * as partnerPools from './partner-pools';
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
		document ??= openApiDocument(API_OPERATIONS, EXTERNAL_ROUTES);
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
	...Object.values(tests),
	...Object.values(companyProfile),
	...Object.values(needs),
	...Object.values(categories),
	...Object.values(grades),
	...Object.values(invitations),
	...Object.values(hiring),
	...Object.values(verify),
	...Object.values(operator)
];

export const EXTERNAL_ROUTES: readonly ExternalRoute[] = Object.values(integrations);
