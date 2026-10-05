// The OpenAPI document of `/api/v1` (docs/contracts.md, section 5.1): generated from the operations, it describes every
// route file of the version and nothing else, each route serves the operation of its method and path, and the document
// holds together — every reference resolves, every path parameter is declared, every operation has its answers.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_CSP, DOCS_HTML, docsAsset } from '$lib/server/api/docs';
import { openApiDocument, type OpenApiDocument } from '$lib/server/api/openapi';
import type { Operation } from '$lib/server/api/operation';
import * as v1 from '$lib/server/api/v1';
import * as applications from '$lib/server/api/v1/applications';
import * as catalog from '$lib/server/api/v1/catalog';
import * as categories from '$lib/server/api/v1/categories';
import * as challenges from '$lib/server/api/v1/challenges';
import * as companies from '$lib/server/api/v1/companies';
import * as companyProfile from '$lib/server/api/v1/company-profile';
import * as complaints from '$lib/server/api/v1/complaints';
import * as events from '$lib/server/api/v1/events';
import * as confirmations from '$lib/server/api/v1/confirmations';
import * as demand from '$lib/server/api/v1/demand';
import * as grades from '$lib/server/api/v1/grades';
import * as hiring from '$lib/server/api/v1/hiring';
import * as invitations from '$lib/server/api/v1/invitations';
import * as me from '$lib/server/api/v1/me';
import * as needs from '$lib/server/api/v1/needs';
import * as operator from '$lib/server/api/v1/operator';
import * as partnerPools from '$lib/server/api/v1/partner-pools';
import * as profile from '$lib/server/api/v1/profile';
import * as shortlists from '$lib/server/api/v1/shortlists';
import * as taxonomy from '$lib/server/api/v1/taxonomy';
import * as tests from '$lib/server/api/v1/tests';
import * as vacancies from '$lib/server/api/v1/vacancies';
import * as verify from '$lib/server/api/v1/verify';

const ROUTES = fileURLToPath(new URL('../../src/routes/api/v1', import.meta.url));
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const document: OpenApiDocument = openApiDocument(v1.API_OPERATIONS, v1.EXTERNAL_ROUTES);

/** Operations by the name they are exported under: route files serve them by that name. */
const exported = new Map<string, Operation>(
	Object.entries({
		getOpenApiDocument: v1.getOpenApiDocument,
		...catalog,
		...categories,
		...companies,
		...companyProfile,
		...complaints,
		...events,
		...grades,
		...hiring,
		...invitations,
		...me,
		...tests,
		...needs,
		...operator,
		...profile,
		...partnerPools,
		...shortlists,
		...taxonomy,
		...vacancies,
		...verify,
		...confirmations,
		...challenges,
		...applications,
		...demand
	})
);

interface RouteFile {
	path: string;
	methods: { method: string; served: string | null }[];
}

async function routeFiles(directory: string): Promise<RouteFile[]> {
	const found: RouteFile[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await routeFiles(full)));
		else if (entry.name === '+server.ts') {
			const source = await readFile(full, 'utf8');
			const segments = relative(ROUTES, directory)
				.split(sep)
				.filter((segment) => segment.length > 0)
				.map((segment) => segment.replace(/^\[(\w+)\]$/u, '{$1}'));
			const methods = [
				...source.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/gu)
			].map(([, method = '']) => ({
				method,
				served: new RegExp(`export const ${method} = serve\\((\\w+)\\)`, 'u').exec(source)?.[1] ?? null
			}));
			found.push({ path: `/api/v1/${segments.join('/')}`.replace(/\/$/u, ''), methods });
		}
	}
	return found;
}

describe('OpenAPI document of /api/v1', () => {
	it('describes every route file of the version and nothing else', async () => {
		const files = await routeFiles(ROUTES);
		const routes = files.flatMap((file) => file.methods.map(({ method }) => `${method} ${file.path}`)).sort();
		const described = Object.entries(document.paths)
			.flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`))
			.sort();
		expect(routes.length).toBeGreaterThan(40);
		expect(described).toEqual(routes);
	});

	it('serves in each route file the operation of its method and path', async () => {
		const files = await routeFiles(ROUTES);
		const webhooks = new Set(v1.EXTERNAL_ROUTES.map((route) => `${route.method} /api/v1${route.path}`));
		for (const file of files) {
			for (const { method, served } of file.methods) {
				if (webhooks.has(`${method} ${file.path}`)) {
					expect(served, `${method} ${file.path} is a webhook served by its module`).toBeNull();
					continue;
				}
				expect(served, `${method} ${file.path} is served by an operation`).not.toBeNull();
				const operation = exported.get(served ?? '');
				expect(operation, `${served ?? ''} is an exported operation`).toBeDefined();
				expect(`${operation?.method ?? ''} /api/v1${operation?.path ?? ''}`).toBe(`${method} ${file.path}`);
			}
		}
	});

	it('resolves every reference and declares every path parameter', () => {
		const schemas = document.components.schemas;
		const references: string[] = [];
		const walk = (value: unknown) => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value !== null && typeof value === 'object') {
				for (const [field, member] of Object.entries(value)) {
					if (field === '$ref' && typeof member === 'string') references.push(member);
					else walk(member);
				}
			}
		};
		walk(document);
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references) {
			expect(reference).toMatch(/^#\/components\/schemas\//u);
			expect(schemas[reference.slice('#/components/schemas/'.length)], reference).toBeDefined();
		}

		const operationIds = new Set<string>();
		const schemes = new Set(Object.keys(document.components.securitySchemes));
		const tags = new Set(document.tags.map((tag) => tag.name));
		for (const [path, item] of Object.entries(document.paths)) {
			const template = [...path.matchAll(/\{(\w+)\}/gu)].map(([, name]) => name).sort();
			for (const [method, raw] of Object.entries(item)) {
				expect(METHODS).toContain(method.toUpperCase());
				const operation = raw as {
					operationId: string;
					tags: string[];
					parameters?: { name: string; in: string; required: boolean }[];
					responses: Record<string, { description?: string }>;
					security: Record<string, string[]>[];
				};
				expect(operationIds.has(operation.operationId), operation.operationId).toBe(false);
				operationIds.add(operation.operationId);
				for (const tag of operation.tags) expect(tags).toContain(tag);
				const declared = (operation.parameters ?? []).filter((p) => p.in === 'path');
				expect(declared.map((p) => p.name).sort(), `${method} ${path}`).toEqual(template);
				expect(declared.every((p) => p.required)).toBe(true);
				const statuses = Object.keys(operation.responses);
				expect(
					statuses.some((status) => status.startsWith('2')),
					`${method} ${path} has a success`
				).toBe(true);
				for (const response of Object.values(operation.responses)) expect(response.description).toBeTruthy();
				for (const requirement of operation.security) {
					for (const scheme of Object.keys(requirement)) expect(schemes).toContain(scheme);
				}
			}
		}
	});

	it('documents the error envelope and the authentication of each kind of operation', () => {
		expect(document.openapi).toBe('3.1.0');
		expect(document.components.schemas.Error).toMatchObject({
			type: 'object',
			properties: { error: { properties: { request_id: { type: 'string' } } } }
		});
		const createInvitation = document.paths['/api/v1/invitations']?.post as {
			security: unknown;
			responses: Record<string, unknown>;
			parameters: { name: string }[];
		};
		expect(createInvitation.security).toEqual([{ session: [] }, { apiKey: [] }]);
		expect(Object.keys(createInvitation.responses)).toEqual(
			expect.arrayContaining(['201', '400', '401', '403', '404', '409', '422', '429'])
		);
		expect(createInvitation.parameters.map((p) => p.name)).toContain('Idempotency-Key');
		const verifyReceipt = document.paths['/api/v1/verify/{handle}']?.get as { security: unknown };
		expect(verifyReceipt.security).toEqual([{}]);
		const respond = document.paths['/api/v1/invitations/{invitation_id}/response']?.post as { security: unknown };
		expect(respond.security).toEqual([{ session: [] }]);
	});

	it('describes the market of a category and the position of a draft range, each indicator apart', () => {
		const market = document.paths['/api/v1/catalog/market']?.get as {
			security: unknown;
			parameters: { name: string; in: string; required: boolean }[];
			responses: Record<string, unknown>;
		};
		expect(market.security).toEqual([{ session: [] }, { apiKey: [] }]);
		expect(market.parameters.filter((p) => p.in === 'query').map((p) => [p.name, p.required])).toEqual([
			['specialization', true],
			['grade', false]
		]);
		expect(Object.keys(market.responses)).toEqual(expect.arrayContaining(['200', '401', '403']));
		const { schemas } = document.components;
		expect(Object.keys((schemas.CategoryMarket as { properties: object }).properties).sort()).toEqual([
			'candidate_expectations',
			'category_key',
			'external_reference',
			'vacancy_ranges'
		]);
		expect(JSON.stringify(schemas.MarketFigure)).toContain('insufficient_data');
		const draft = document.paths['/api/v1/vacancies/drafts/from-text']?.post as {
			responses: { 200: { content: { 'application/json': { schema: { properties: Record<string, unknown> } } } } };
		};
		expect(draft.responses[200].content['application/json'].schema.properties.market_position).toEqual({
			$ref: '#/components/schemas/VacancyMarketPosition'
		});
	});

	it('describes the role and the trust of each compared candidate', () => {
		const comparison = document.paths['/api/v1/catalog/comparison']?.get as {
			responses: { 200: { content: { 'application/json': { schema: unknown } } } };
		};
		const schema = comparison.responses[200].content['application/json'].schema as {
			properties: { candidates: { items: { properties: Record<string, { properties: Record<string, unknown> }> } } };
		};
		const candidate = schema.properties.candidates.items.properties;
		expect(Object.keys(candidate)).toEqual(expect.arrayContaining(['role', 'trust']));
		expect(JSON.stringify(candidate.role)).toContain('same_specialization');
		expect(JSON.stringify(candidate.role)).toContain('other_specialization');
		expect(JSON.stringify(candidate.trust)).toContain('grade_agreement');
		expect(JSON.stringify(candidate.trust)).toContain('public_profile');
	});

	it('withdraws a «this is our vacancy» claim by the session of a company member, answering without a body', () => {
		const withdrawal = document.paths['/api/v1/vacancies/{vacancy_id}/claims/{claim_id}/withdrawal']?.post as {
			operationId: string;
			security: unknown;
			parameters: { name: string; in: string; required: boolean }[];
			responses: Record<string, { content?: unknown }>;
		};
		expect(withdrawal.operationId).toBe('withdrawVacancyClaim');
		expect(withdrawal.security).toEqual([{ session: [] }]);
		expect(withdrawal.parameters.filter((p) => p.in === 'path').map((p) => p.name)).toEqual(['vacancy_id', 'claim_id']);
		expect(withdrawal.responses['204']?.content).toBeUndefined();
		expect(Object.keys(withdrawal.responses)).toEqual(expect.arrayContaining(['204', '404', '422']));
		expect(withdrawal.responses['201']).toBeUndefined();
	});

	it('takes an offer without a vacancy: the range in roubles with its tax base, «why you» and the contact', () => {
		const createInvitation = document.paths['/api/v1/invitations']?.post as {
			requestBody: {
				content: { 'application/json': { schema: { properties: Record<string, unknown>; required: string[] } } };
			};
		};
		const schema = createInvitation.requestBody.content['application/json'].schema;
		expect(Object.keys(schema.properties).sort()).toEqual([
			'candidate_pseudonym',
			'contact_method',
			'description',
			'message',
			'need_id',
			'salary_currency',
			'salary_max',
			'salary_min',
			'salary_tax_base',
			'title',
			'vacancy_id',
			'why_you',
			'work_format'
		]);
		// The vacancy is optional; the period is not taken: an offer is a range per month.
		expect(schema.required).not.toContain('vacancy_id');
		expect(schema.required).toEqual(expect.arrayContaining(['salary_currency', 'salary_tax_base', 'why_you']));
		expect(JSON.stringify(schema.properties.salary_currency)).toContain('RUB');
	});

	it('describes the profile of the company and the needs with their recommended categories', () => {
		expect(Object.keys(document.paths['/api/v1/company/profile'] ?? {}).sort()).toEqual(['get', 'patch']);
		expect(Object.keys(document.paths['/api/v1/needs'] ?? {}).sort()).toEqual(['get', 'post']);
		expect(Object.keys(document.paths['/api/v1/needs/{need_id}'] ?? {}).sort()).toEqual(['get', 'patch']);
		const categories = document.paths['/api/v1/needs/{need_id}/categories']?.get as {
			responses: Record<string, unknown>;
		};
		expect(Object.keys(categories.responses)).toEqual(expect.arrayContaining(['200', '404', '503']));
	});
});

describe('Swagger UI page', () => {
	it('loads only its own assets under a policy without external sources', async () => {
		const sources = [...DOCS_HTML.matchAll(/(?:src|href)="([^"]+)"/gu)].map(([, source]) => source ?? '');
		expect(sources).toEqual(['/api/docs/swagger-ui.css', '/api/docs/swagger-ui-bundle.js', '/api/docs/init.js']);
		expect(DOCS_CSP).toContain("script-src 'self'");
		expect(DOCS_CSP).not.toMatch(/https?:|\*/u);
		const initializer = await docsAsset('init.js');
		expect(initializer.body).toContain("url: '/api/v1/openapi.json'");
		expect(initializer.body).toContain('validatorUrl: null');
	});
});
