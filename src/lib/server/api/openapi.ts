// The OpenAPI 3.1 document of `/api/v1`, generated from the operations and their Zod schemas (contracts 5.1): the same
// schemas parse requests and shape answers, so the document cannot drift from the handlers. Never edited by hand.
import { z } from 'zod';
import { API_ERRORS, type ApiErrorCode } from '$lib/server/errors/codes';
import { canonicalJson } from '$lib/server/json/canonical';
import { API_BASE, type HttpMethod, type Operation } from './operation';
import { errorEnvelope } from './schemas';

type JsonSchema = Record<string, unknown>;

// A type alias rather than an interface: the document is plain JSON and is answered through a record schema.
export type OpenApiDocument = {
	openapi: '3.1.0';
	info: { title: string; version: string; description: string };
	servers: { url: string }[];
	tags: { name: string; description: string }[];
	paths: Record<string, Record<string, JsonSchema>>;
	components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, JsonSchema> };
};

/**
 * A route of the version served by its own module rather than by an operation (webhooks authenticated by a signature
 * or a secret); described here so the document covers every route.
 */
export interface ExternalRoute {
	id: string;
	method: HttpMethod;
	path: string;
	tag: string;
	summary: string;
	description: string;
	security: 'fspSignature' | 'telegramSecret';
	body: z.ZodType;
	responses: Record<number, { description: string; schema?: z.ZodType }>;
}

const DEFS_PREFIX = '#/$defs/';
const COMPONENTS_PREFIX = '#/components/schemas/';

/**
 * Named schemas of the document, one entry per id. A request and an answer see the same Zod schema differently (an
 * answer has no unknown members, a request may omit defaults), so the request form of a named schema is `<id>Input`.
 */
class Components {
	readonly schemas: Record<string, JsonSchema> = {};

	private register(name: string, schema: JsonSchema): void {
		const existing = this.schemas[name];
		if (existing === undefined) this.schemas[name] = schema;
		else if (canonicalJson(existing) !== canonicalJson(schema)) {
			throw new Error(`schema id ${name} names two different schemas`);
		}
	}

	/** JSON Schema of a Zod schema; schemas with an `id` become references to components. */
	convert(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
		const converted = z.toJSONSchema(schema, {
			target: 'draft-2020-12',
			io,
			unrepresentable: 'throw',
			reused: 'inline',
			// A named format (`uuid`, `date-time`, `date`) says what the value is; the regular expression Zod adds for it
			// repeats that at the size of a paragraph in every field.
			override: ({ jsonSchema }) => {
				if (typeof jsonSchema.format === 'string') delete jsonSchema.pattern;
			}
		}) as JsonSchema & { $defs?: Record<string, JsonSchema> };
		const { $defs, ...withDialect } = converted;
		// The document declares the dialect once; a schema inside it carries none.
		const root = Object.fromEntries(Object.entries(withDialect).filter(([field]) => field !== '$schema'));
		const nameOf = (id: string) => (io === 'input' ? `${id}Input` : id);
		const rewrite = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(rewrite);
			if (value === null || typeof value !== 'object') return value;
			return Object.fromEntries(
				Object.entries(value).map(([field, member]) =>
					field === '$ref' && typeof member === 'string' && member.startsWith(DEFS_PREFIX)
						? [field, `${COMPONENTS_PREFIX}${nameOf(member.slice(DEFS_PREFIX.length))}`]
						: [field, rewrite(member)]
				)
			);
		};
		for (const [id, definition] of Object.entries($defs ?? {})) {
			this.register(nameOf(id), rewrite(definition) as JsonSchema);
		}
		return rewrite(root) as JsonSchema;
	}
}

/** Whether a parameter may be omitted: its schema accepts absence (optional or with a default). */
function isOptional(field: z.ZodType): boolean {
	return field.safeParse(undefined).success;
}

function parametersOf(components: Components, operation: Operation): JsonSchema[] {
	const parameters: JsonSchema[] = [];
	for (const [location, shape] of [
		['path', operation.params.shape],
		['query', operation.query.shape]
	] as const) {
		for (const [name, field] of Object.entries(shape) as [string, z.ZodType][]) {
			const { description, ...schema } = components.convert(field, 'input');
			const repeated = schema.type === 'array';
			parameters.push({
				name,
				in: location,
				required: location === 'path' || !isOptional(field),
				...(typeof description === 'string' ? { description } : {}),
				schema,
				...(repeated ? { style: 'form', explode: true } : {})
			});
		}
	}
	if (operation.idempotent) {
		parameters.push({
			name: 'Idempotency-Key',
			in: 'header',
			required: false,
			description:
				'Ключ идемпотентности: повтор с тем же ключом и тем же запросом в течение 24 часов вернёт сохранённый ответ ' +
				'(заголовок `Idempotent-Replayed: true`), с другим запросом — `409 idempotency_conflict`',
			schema: { type: 'string', minLength: 1, maxLength: 255 }
		});
	}
	if (operation.auth !== 'public' && operation.method !== 'GET') {
		parameters.push({
			name: 'X-CSRF-Token',
			in: 'header',
			required: false,
			description: 'CSRF-токен сессии: обязателен для запросов из браузера по cookie; с ключом API не нужен',
			schema: { type: 'string' }
		});
	}
	return parameters;
}

/** Error codes the operation may answer with: its own and those every operation of its kind has. */
function errorCodesOf(operation: Operation): ApiErrorCode[] {
	const codes = new Set<ApiErrorCode>(operation.errors);
	const hasInput =
		Object.keys(operation.params.shape).length > 0 ||
		Object.keys(operation.query.shape).length > 0 ||
		operation.body !== undefined;
	if (hasInput) codes.add('validation_failed');
	if (operation.auth !== 'public' || operation.permission !== undefined) codes.add('unauthenticated');
	if (operation.auth === 'session' || operation.permission !== undefined) codes.add('forbidden');
	if (operation.auth !== 'public' && operation.method !== 'GET') codes.add('csrf_failed');
	if (operation.idempotent) {
		codes.add('idempotency_conflict');
		codes.add('conflict');
	}
	codes.add('rate_limited');
	codes.add('internal');
	codes.add('degraded');
	return [...codes];
}

function responsesOf(components: Components, operation: Operation): Record<string, JsonSchema> {
	const responses: Record<string, JsonSchema> = {};
	const { status, description, schema } = operation.response;
	responses[String(status)] =
		schema === undefined
			? { description }
			: { description, content: { 'application/json': { schema: components.convert(schema, 'output') } } };
	const byStatus = new Map<number, ApiErrorCode[]>();
	for (const code of errorCodesOf(operation)) {
		const httpStatus = API_ERRORS[code].status;
		byStatus.set(httpStatus, [...(byStatus.get(httpStatus) ?? []), code]);
	}
	const envelope = components.convert(errorEnvelope, 'output');
	for (const [httpStatus, codes] of [...byStatus.entries()].sort(([a], [b]) => a - b)) {
		responses[String(httpStatus)] = {
			description: codes.map((code) => `\`${code}\` — ${API_ERRORS[code].message}`).join('; '),
			content: { 'application/json': { schema: envelope } }
		};
	}
	return responses;
}

function securityOf(operation: Operation): JsonSchema[] {
	switch (operation.auth) {
		case 'public':
			return operation.permission === undefined ? [{}] : [{}, { session: [] }, { apiKey: [] }];
		case 'session':
			return [{ session: [] }];
		case 'account':
			return [{ session: [] }, { apiKey: [] }];
	}
}

function describe(operation: Operation): string {
	const who = {
		public: 'Без входа.',
		session: 'Только сессия браузера (ключу API недоступно).',
		account: 'Сессия или ключ API компании.'
	}[operation.auth];
	const parts = [operation.description, who];
	if (operation.permission !== undefined) parts.push(`Право: \`${operation.permission}\`.`);
	return parts.filter((part): part is string => part !== undefined).join('\n\n');
}

export const API_TAGS: { name: string; description: string }[] = [
	{ name: 'Документация', description: 'Этот документ' },
	{ name: 'Справочники', description: 'Роли, навыки, грейды и форматы работы активной версии таксономии' },
	{ name: 'Компании', description: 'Профиль компании, проверка, команда и ключи API' },
	{ name: 'Вакансии', description: 'Собственные вакансии компании и общий поиск вакансий с атрибуцией источников' },
	{ name: 'Каталог', description: 'Поиск кандидатов, карточка в проекции каталога, сравнение и соответствие вакансии' },
	{ name: 'Кандидат', description: 'Своя категория с объяснением, возражение, свои рекомендации' },
	{
		name: 'Категория и грейд',
		description:
			'Справочник категорий, опрос кандидата, подсказка и заявление грейда, доступные тесты по политике грейда'
	},
	{ name: 'Приглашения', description: 'Приглашения с версиями условий, ответ кандидата и раскрытие контактов' },
	{ name: 'Найм', description: 'Этапы и исход процесса найма от обеих сторон' },
	{ name: 'Квитанции', description: 'Публичная проверка квитанции без входа' },
	{ name: 'ФСП', description: 'Кабинет оператора ФСП' },
	{ name: 'Интеграции', description: 'Вебхуки внешних систем, аутентифицированные подписью или секретом' }
];

const DESCRIPTION = [
	'Публичный API платформы «ФСП Карьера».',
	'',
	'**Аутентификация.** Сессия браузера (cookie `__Host-session`; небезопасные методы — с `X-CSRF-Token`) или ключ API',
	'компании: `Authorization: Bearer fspk_<prefix>_<secret>`. Права ключа — подмножество прав создателя; членство и статус',
	'компании проверяются на каждом запросе. Ключам недоступны операции кандидата, персонала и управления ключами.',
	'',
	'**Ошибки** — единый конверт `Error`; `request_id` совпадает с заголовком `X-Request-Id`. Объект чужой компании и',
	'объект, о котором актор не вправе знать, — `404 not_found`; отсутствие права при доступном объекте — `403 forbidden`.',
	'',
	'**Пагинация** — курсорная: `?cursor=&limit=` (до 100), в ответе `next_cursor`.',
	'',
	'**Лимиты** — по адресу и по ключу API; заголовки `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`,',
	'при превышении — `429` с `Retry-After`.',
	'',
	'**Версия.** В пределах `v1` изменения только добавляющие.'
].join('\n');

export function openApiDocument(
	operations: readonly Operation[],
	externalRoutes: readonly ExternalRoute[]
): OpenApiDocument {
	const components = new Components();
	const paths: OpenApiDocument['paths'] = {};
	const ids = new Set<string>();
	const place = (id: string, method: HttpMethod, path: string, entry: JsonSchema) => {
		if (ids.has(id)) throw new Error(`operation id ${id} is used twice`);
		ids.add(id);
		const item = (paths[`${API_BASE}${path}`] ??= {});
		const name = method.toLowerCase();
		if (item[name] !== undefined) throw new Error(`${method} ${path} is declared twice`);
		item[name] = entry;
	};
	for (const operation of operations) {
		place(operation.id, operation.method, operation.path, {
			operationId: operation.id,
			tags: [operation.tag],
			summary: operation.summary,
			description: describe(operation),
			parameters: parametersOf(components, operation),
			...(operation.body === undefined
				? {}
				: {
						requestBody: {
							required: true,
							content: { 'application/json': { schema: components.convert(operation.body, 'input') } }
						}
					}),
			responses: responsesOf(components, operation),
			security: securityOf(operation),
			...(operation.permission === undefined ? {} : { 'x-permission': operation.permission })
		});
	}
	for (const route of externalRoutes) {
		place(route.id, route.method, route.path, {
			operationId: route.id,
			tags: [route.tag],
			summary: route.summary,
			description: route.description,
			requestBody: {
				required: true,
				content: { 'application/json': { schema: components.convert(route.body, 'input') } }
			},
			responses: Object.fromEntries(
				Object.entries(route.responses).map(([status, response]) => [
					status,
					response.schema === undefined
						? { description: response.description }
						: {
								description: response.description,
								content: { 'application/json': { schema: components.convert(response.schema, 'output') } }
							}
				])
			),
			security: [{ [route.security]: [] }]
		});
	}
	return {
		openapi: '3.1.0',
		info: { title: 'ФСП Карьера — публичный API', version: '1', description: DESCRIPTION },
		servers: [{ url: '/' }],
		tags: API_TAGS,
		paths,
		components: {
			schemas: components.schemas,
			securitySchemes: {
				session: {
					type: 'apiKey',
					in: 'cookie',
					name: '__Host-session',
					description: 'Сессия браузера после входа'
				},
				apiKey: {
					type: 'http',
					scheme: 'bearer',
					bearerFormat: 'fspk_<prefix>_<secret>',
					description: 'Ключ API компании; выдаёт владелец в кабинете, показывается один раз'
				},
				fspSignature: {
					type: 'apiKey',
					in: 'header',
					name: 'X-FSP-Signature',
					description: 'Подпись вебхука ФСП (раздел 1.5 контракта)'
				},
				telegramSecret: {
					type: 'apiKey',
					in: 'header',
					name: 'X-Telegram-Bot-Api-Secret-Token',
					description: 'Секрет вебхука бота (раздел 8.2 контракта)'
				}
			}
		}
	};
}
