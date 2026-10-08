// Load run against a demonstration stand (docs/contracts.md, section 11): virtual users enter roles of the scenario on
// `/demo`, several to one demo session, each as its own account, and repeat mixed operations of employers and
// candidates with a pause between them. The number of users grows in stages; the run stops early when the share of
// failed requests of the last stage passes the limit. The report — p50/p95/p99 by operation, errors, 429, the share of
// the extraction answered by the model — goes to stdout as a table and to `--out` as JSON.
//
//   node scripts/load/run.ts --origin https://fsp-career.volkv.com [--stages 10,20,40] [--stage-seconds 120]
//        [--users-per-session 5] [--specializations backend,data_ml,qa] [--model-parses 60] [--sandbox-parallel 8]
//        [--think-ms 2000-5000] [--max-error-rate 0.05] [--out report.json]
//   node scripts/load/run.ts --origin … --practice-burst 8 [--sandbox-parallel 8]
//
// `--specializations` — the open ones of the stand: a need of a closed one is refused. `--model-parses` caps the needs
// parsed from text (each is a call of the model when the stand has one). `--practice-burst` replaces the stages: that
// many candidates bring an attempt to its practice task and answer it at once, the wait of each is measured.
//
// Requests leave through HTTP(S)_PROXY of the environment with NODE_USE_ENV_PROXY=1. Every request of the run counts
// against the limits of one client address of the stand (`src/lib/server/http/rate-limit.ts`): 600 API requests a
// minute and 60 new demo sessions a day; 40 users with `--think-ms 4000-8000` stay below the first (≈ 500 a minute).
// Demo sessions of the run are ordinary ones: they end by their idle time or at the nightly reset of the stand.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const { values: args } = parseArgs({
	options: {
		origin: { type: 'string' },
		stages: { type: 'string', default: '10,20,40' },
		'stage-seconds': { type: 'string', default: '120' },
		'users-per-session': { type: 'string', default: '5' },
		specializations: { type: 'string', default: 'backend,data_ml,qa' },
		'model-parses': { type: 'string', default: '60' },
		'sandbox-parallel': { type: 'string', default: '8' },
		'think-ms': { type: 'string', default: '2000-5000' },
		'max-error-rate': { type: 'string', default: '0.05' },
		'practice-burst': { type: 'string' },
		'request-timeout-ms': { type: 'string', default: '30000' },
		out: { type: 'string' }
	}
});

function positiveInt(name: string, value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer, got ${value}`);
	return parsed;
}

if (!args.origin) throw new Error('--origin is required, for example --origin https://fsp-career.volkv.com');
const ORIGIN = args.origin.replace(/\/$/u, '');
const STAGES = args.stages.split(',').map((v) => positiveInt('stages', v));
const STAGE_MS = positiveInt('stage-seconds', args['stage-seconds']) * 1000;
const USERS_PER_SESSION = positiveInt('users-per-session', args['users-per-session']);
// Every user of a session is a different account: the three employers of the cast, then up to five candidates.
if (USERS_PER_SESSION < 4 || USERS_PER_SESSION > 8) throw new Error('--users-per-session is from 4 to 8');
const MODEL_PARSES = Number(args['model-parses']);
if (!Number.isInteger(MODEL_PARSES) || MODEL_PARSES < 0) throw new Error('--model-parses must be 0 or more');
const SANDBOX_PARALLEL = positiveInt('sandbox-parallel', args['sandbox-parallel']);
const [THINK_MIN, THINK_MAX] = args['think-ms'].split('-').map((v) => positiveInt('think-ms', v));
if (THINK_MIN === undefined || THINK_MAX === undefined || THINK_MIN > THINK_MAX) {
	throw new Error('--think-ms is <min>-<max> in milliseconds');
}
const MAX_ERROR_RATE = Number(args['max-error-rate']);
const PRACTICE_BURST =
	args['practice-burst'] === undefined ? null : positiveInt('practice-burst', args['practice-burst']);
if (PRACTICE_BURST !== null && PRACTICE_BURST > SANDBOX_PARALLEL) {
	throw new Error('--practice-burst must not exceed --sandbox-parallel: the burst answers all at once');
}
const REQUEST_TIMEOUT_MS = positiveInt('request-timeout-ms', args['request-timeout-ms']);

// --- Measurements --------------------------------------------------------------------------------------------------

type Outcome = 'ok' | 'client_error' | 'rate_limited' | 'server_error' | 'timeout' | 'network';

interface Sample {
	op: string;
	ms: number;
	outcome: Outcome;
	stage: number;
	/** A request of the stand, as opposed to a derived measurement (`practice_result`, `need_text_*`). */
	request: 'api' | 'page' | null;
}

const samples: Sample[] = [];
let currentStage = 0;
let stopping = false;
/** Read through a call: the flag changes while a user awaits, which the narrowing of a plain read does not see. */
const isStopping = () => stopping;
let stopReason: string | null = null;

const FAILED: ReadonlySet<Outcome> = new Set(['rate_limited', 'server_error', 'timeout', 'network']);

function record(op: string, ms: number, outcome: Outcome, path: string | null = null): void {
	const request = path === null ? null : path.startsWith('/api/') ? 'api' : 'page';
	samples.push({ op, ms, outcome, stage: currentStage, request });
}

function outcomeOf(status: number): Outcome {
	if (status === 429) return 'rate_limited';
	if (status >= 500) return 'server_error';
	if (status >= 400) return 'client_error';
	return 'ok';
}

/** A failure of the stand the user would see, as opposed to an expected refusal of the operation. */
class StandFailure extends Error {
	override name = 'StandFailure';
}

const ApiRefusal = z.object({
	error: z.object({ code: z.string(), details: z.array(z.object({ code: z.string() })).optional() })
});

// --- HTTP client of one browser --------------------------------------------------------------------------------------

interface Reply {
	status: number;
	location: string | null;
	text: string;
}

class Browser {
	readonly #cookies = new Map<string, string>();
	csrf: string | null = null;

	cookie(name: string): string | null {
		return this.#cookies.get(name) ?? null;
	}

	/**
	 * One request, measured under `op`. A redirect is not followed. Statuses in `expected` other than 2xx and 3xx are
	 * the operation's own answers (a conflict of a test attempt) and are counted as `client_error`, not failures.
	 */
	async request(op: string, method: string, path: string, body?: unknown, form = false): Promise<Reply> {
		const headers: Record<string, string> = {
			origin: ORIGIN,
			accept: path.startsWith('/api/') ? 'application/json' : 'text/html'
		};
		const cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
		if (cookie) headers.cookie = cookie;
		if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
		let payload: string | undefined;
		if (body !== undefined) {
			headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
			payload = form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
		}
		const started = performance.now();
		let response: Response;
		let text: string;
		try {
			response = await fetch(ORIGIN + path, {
				method,
				headers,
				body: payload,
				redirect: 'manual',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			text = await response.text();
		} catch (cause) {
			const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
			record(op, performance.now() - started, timedOut ? 'timeout' : 'network', path);
			throw new StandFailure(`${op}: ${timedOut ? 'timeout' : 'network error'}`, { cause });
		}
		const ms = performance.now() - started;
		for (const line of response.headers.getSetCookie()) {
			const pair = line.split(';')[0] ?? '';
			const eq = pair.indexOf('=');
			if (eq > 0) this.#cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
		}
		const outcome = outcomeOf(response.status);
		record(op, ms, outcome, path);
		if (FAILED.has(outcome)) throw new StandFailure(`${op}: HTTP ${response.status}`);
		return { status: response.status, location: response.headers.get('location'), text };
	}

	/** A page with its redirects, measured as one operation; the CSRF token of the page is kept for later requests. */
	async page(op: string, path: string): Promise<string> {
		let target = path;
		for (let hop = 0; hop < 3; hop++) {
			const reply = await this.request(op, 'GET', target);
			if (reply.status >= 300 && reply.status < 400 && reply.location) {
				target = reply.location;
				continue;
			}
			if (reply.status !== 200) throw new Error(`${op}: page ${target} answered ${reply.status}`);
			const token = /name="csrf_token" value="([^"]+)"/u.exec(reply.text)?.[1];
			if (token) this.csrf = token;
			return reply.text;
		}
		throw new Error(`${op}: page ${path} redirects more than three times`);
	}

	/**
	 * A JSON request whose 2xx body is checked against `schema`; another status comes back with the error code of its
	 * body (`error.code`, then the first `details[].code`) and no data.
	 */
	async json<S extends z.ZodType>(
		op: string,
		method: string,
		path: string,
		schema: S,
		body?: unknown
	): Promise<{ status: number; data: z.infer<S> | null; error: string | null }> {
		const reply = await this.request(op, method, path, body);
		if (reply.status >= 200 && reply.status < 300) {
			return { status: reply.status, data: schema.parse(JSON.parse(reply.text)), error: null };
		}
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(reply.text);
		} catch (cause) {
			// A body that is not JSON (a proxy's page) is named below by its first characters.
			if (!(cause instanceof SyntaxError)) throw cause;
		}
		const refusal = ApiRefusal.safeParse(parsed);
		const error = refusal.success
			? [refusal.data.error.code, ...(refusal.data.error.details ?? []).map((d) => d.code)].join('/')
			: `unparsed body ${reply.text.slice(0, 120)}`;
		return { status: reply.status, data: null, error };
	}
}

// --- Scenario data -------------------------------------------------------------------------------------------------

const EMPLOYER_ROLES = ['member:severny_kod_owner', 'member:severny_kod_recruiter', 'member:teply_stek_recruiter'];
const CANDIDATE_ROLES = ['candidate:k1', 'candidate:k2', 'candidate:k3', 'candidate:k5', 'candidate:k6'];
const SPECIALIZATION_KEYS = ['backend', 'data_ml', 'qa'] as const;
type Specialization = (typeof SPECIALIZATION_KEYS)[number];
const isSpecialization = (key: string): key is Specialization =>
	(SPECIALIZATION_KEYS as readonly string[]).includes(key);
/** Specializations open on the stand (a released bank): needs and searches go to them; tests are Backend. */
const SPECIALIZATIONS = args.specializations.split(',').map((key) => {
	if (!isSpecialization(key))
		throw new Error(`--specializations: ${key} is not one of ${SPECIALIZATION_KEYS.join(', ')}`);
	return key;
});
const GRADES = ['intern', 'junior', 'middle', 'senior'] as const;
const SKILLS = {
	backend: ['python', 'go', 'java', 'sql', 'kafka', 'rest', 'grpc', 'django', 'spring', 'microservices', 'nodejs'],
	data_ml: ['python', 'sql', 'r', 'scala', 'julia', 'kafka'],
	qa: ['python', 'java', 'sql', 'javascript', 'rest', 'bash']
} as const;
const WORK_FORMATS = ['office', 'hybrid', 'remote'] as const;
const NEED_TEXTS = [
	'Ищем бэкенд-разработчика уровня {grade} в команду платежей. Нужны {a} и {b}, {c} будет плюсом. Формат — {format}.',
	'Нужен {grade} разработчик серверной части: {a}, {b}; опыт с {c} желателен. Команда из шести человек, {format}.',
	'В отдел данных ищем аналитика или ML-инженера уровня {grade}: {a} и {b} обязательно, {c} — плюс. Работа {format}.',
	'Ищем тестировщика {grade}: автотесты на {a}, проверка API, {b}; знание {c} приветствуется. Формат {format}.'
];
const FORMAT_WORDS = { office: 'в офисе', hybrid: 'гибрид', remote: 'удалённо' } as const;

const pick = <T>(list: readonly T[]): T => {
	const item = list[Math.floor(Math.random() * list.length)];
	if (item === undefined) throw new Error('pick from an empty list');
	return item;
};
const sample = <T>(list: readonly T[], n: number): T[] => [...list].sort(() => Math.random() - 0.5).slice(0, n);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const think = () => sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));

let modelParsesLeft = MODEL_PARSES;
const parseModes = { model: 0, rules: 0, failures: new Map<string, number>() };

/** At most `SANDBOX_PARALLEL` practice answers wait for the sandbox at once. */
let sandboxBusy = 0;
let sandboxPeak = 0;
const sandboxWaiters: (() => void)[] = [];
async function sandboxSlot(): Promise<() => void> {
	while (sandboxBusy >= SANDBOX_PARALLEL) await new Promise<void>((resolve) => sandboxWaiters.push(resolve));
	sandboxBusy++;
	sandboxPeak = Math.max(sandboxPeak, sandboxBusy);
	return () => {
		sandboxBusy--;
		sandboxWaiters.shift()?.();
	};
}

// --- Virtual users -------------------------------------------------------------------------------------------------

/**
 * The join token of each demo session of the run, settled by the user who opens the session — or why it was not
 * opened, which its other users report as their own failure to start.
 */
const sessions: PromiseWithResolvers<string | Error>[] = [];

/** Enters the role in the user's demo session: the first user of a session opens it, the others join by its token. */
async function enter(browser: Browser, slot: number, role: string): Promise<void> {
	const joined = sessions[slot];
	if (joined) {
		const join = await joined.promise;
		if (join instanceof Error) throw new Error(`the demo session was not opened: ${join.message}`);
		await browser.request('demo_join', 'POST', '/demo?/enter', { role, join }, true);
		if (!browser.cookie('__Host-session')) throw new Error(`joining as ${role} gave no sign-in cookie`);
		return;
	}
	const opened = Promise.withResolvers<string | Error>();
	sessions[slot] = opened;
	try {
		const reply = await browser.request('demo_open', 'POST', '/demo?/enter', { role, join: '' }, true);
		const token = browser.cookie('__Host-demo_session');
		if (!token || !browser.cookie('__Host-session')) {
			throw new Error(`entering ${role} gave no session cookies (HTTP ${reply.status}): ${reply.text.slice(0, 200)}`);
		}
		opened.resolve(token);
	} catch (cause) {
		opened.resolve(cause instanceof Error ? cause : new Error(String(cause)));
		throw cause;
	}
}

// Only the fields the run reads; the rest of each body is dropped by the parse.
const Created = z.object({ id: z.string() });
const ShortlistCreated = z.object({ shortlist_id: z.string() });
const Shortlist = z.object({ items: z.array(z.object({ pseudonym: z.string() })) });
const NeedWithParse = z.object({
	parse: z.object({ mode: z.enum(['model', 'rules']), model_failure: z.string().nullable() }).nullable()
});
const AnyBody = z.unknown();
const TestItem = z.object({
	seq: z.number(),
	practice: z.boolean(),
	answer_kind: z.string(),
	answers: z.array(z.unknown()),
	change_step: z.unknown(),
	languages: z.array(z.string())
});
const Attempt = z.object({
	id: z.string(),
	status: z.string(),
	current: z.number().nullable(),
	waiting_sandbox: z.boolean(),
	items: z.array(TestItem)
});
type Attempt = z.infer<typeof Attempt>;
const TestStep = z.object({ kind: z.string(), attempt: Attempt });

/** The body of a reply with the status the operation expects; any other status stops the step of the user. */
function expect<T>(op: string, reply: { status: number; data: T | null; error: string | null }, status: number): T {
	if (reply.status !== status || reply.data === null)
		throw new Error(`${op} answered ${reply.status} ${reply.error ?? ''}`);
	return reply.data;
}

class Employer {
	readonly browser = new Browser();
	needId: string | null = null;
	shortlistId: string | null = null;
	pseudonyms: string[] = [];

	async start(index: number): Promise<void> {
		await enter(this.browser, Math.floor(index / USERS_PER_SESSION), EMPLOYER_ROLES[index % USERS_PER_SESSION] ?? '');
		await this.browser.page('page_company', '/company/vacancies');
	}

	async step(): Promise<void> {
		const roll = Math.random();
		if (roll < 0.05 && modelParsesLeft > 0) return this.needFromText();
		if (roll < 0.3 || this.shortlistId === null) return this.coldShortlist();
		if (roll < 0.45) return this.catalogSearch();
		if (roll < 0.6) return this.card();
		if (roll < 0.7) {
			await this.browser.page('page_shortlist', `/company/shortlists/${this.shortlistId}`);
			return;
		}
		if (roll < 0.8) {
			await this.browser.json('shortlist_warm', 'GET', `/api/v1/shortlists/${this.shortlistId}`, Shortlist);
			return;
		}
		if (roll < 0.85) {
			const change = pick([{ work_format: 'remote' }, { grade: 'senior' }, { fsp_only: true }]);
			const query = encodeURIComponent(JSON.stringify(change));
			await this.browser.json(
				'what_if',
				'GET',
				`/api/v1/shortlists/${this.shortlistId}/what-if?change=${query}`,
				AnyBody
			);
			return;
		}
		await this.browser.page(
			'page_company',
			pick(['/company/vacancies', '/company/needs', '/company/invitations', '/company/hiring'])
		);
	}

	/** A new need from the form (no model), its categories and its first shortlist: the ranking is never cached. */
	async coldShortlist(): Promise<void> {
		const specialization = pick(SPECIALIZATIONS);
		const grade = pick(GRADES);
		const form = {
			specialization,
			grade: { min: grade, max: grade },
			skill_keys: sample(SKILLS[specialization], 1 + Math.floor(Math.random() * 3)),
			nice_skill_keys: sample(SKILLS[specialization], 1),
			work_format: pick(WORK_FORMATS)
		};
		const need = expect(
			'need_form',
			await this.browser.json('need_form', 'POST', '/api/v1/needs', Created, { form }),
			201
		);
		this.needId = need.id;
		await this.browser.json('need_categories', 'GET', `/api/v1/needs/${need.id}/categories`, AnyBody);
		const created = expect(
			'shortlist_create',
			await this.browser.json('shortlist_create', 'POST', `/api/v1/needs/${need.id}/shortlists`, ShortlistCreated, {}),
			201
		);
		this.shortlistId = created.shortlist_id;
		const shortlist = expect(
			'shortlist_cold',
			await this.browser.json('shortlist_cold', 'GET', `/api/v1/shortlists/${created.shortlist_id}`, Shortlist),
			200
		);
		this.pseudonyms = shortlist.items.map((item) => item.pseudonym);
	}

	/** A need from its text: the stand parses it with the model when it is on, by the rules otherwise. */
	async needFromText(): Promise<void> {
		modelParsesLeft--;
		const format = pick(WORK_FORMATS);
		const [a, b, c] = sample(SKILLS.backend, 3);
		const text = pick(NEED_TEXTS)
			.replace('{grade}', pick(['junior', 'middle', 'senior']))
			.replace('{a}', a ?? 'Python')
			.replace('{b}', b ?? 'SQL')
			.replace('{c}', c ?? 'Kafka')
			.replace('{format}', FORMAT_WORDS[format]);
		// A random tail makes every text unique: the extraction is never answered from a cache.
		const body = { text: `${text} Заявка ${Math.random().toString(36).slice(2, 8)}.` };
		const started = performance.now();
		const need = expect(
			'need_text',
			await this.browser.json('need_text', 'POST', '/api/v1/needs', NeedWithParse, body),
			201
		);
		const ms = performance.now() - started;
		if (!need.parse) throw new Error('need_text: a need with text came without its parse');
		parseModes[need.parse.mode]++;
		const failure = need.parse.model_failure;
		if (failure) parseModes.failures.set(failure, (parseModes.failures.get(failure) ?? 0) + 1);
		record(`need_text_${need.parse.mode}`, ms, 'ok');
	}

	async catalogSearch(): Promise<void> {
		const specialization = pick(SPECIALIZATIONS);
		const params = new URLSearchParams({
			specialization,
			grade: pick(GRADES),
			text: sample(SKILLS[specialization], 2).join(' '),
			work_format: pick(WORK_FORMATS)
		});
		await this.browser.json('catalog_search', 'GET', `/api/v1/catalog/candidates?${params}`, AnyBody);
	}

	async card(): Promise<void> {
		const pseudonym = this.pseudonyms.length > 0 ? pick(this.pseudonyms) : null;
		if (!pseudonym) return this.coldShortlist();
		if (Math.random() < 0.5) await this.browser.page('page_card', `/company/candidates/${pseudonym}`);
		else await this.browser.json('card', 'GET', `/api/v1/candidates/${pseudonym}`, AnyBody);
	}
}

const practiceWaits: number[] = [];
/** How often a candidate of the mixed run waiting for the sandbox reads the attempt; every read counts against the API limit. */
const PRACTICE_POLL_MS = 2000;
/** The same for the practice burst: a finer reading of the wait, for a few seconds only. */
const BURST_POLL_MS = 500;

class Candidate {
	readonly browser = new Browser();
	attempt: Attempt | null = null;
	/** A request of the attempt failed: what the stand holds is read again before the next answer. */
	stale = false;

	readonly seat: (index: number) => { slot: number; role: string };

	constructor(seat: (index: number) => { slot: number; role: string }) {
		this.seat = seat;
	}

	async start(index: number): Promise<void> {
		const { slot, role } = this.seat(index);
		await enter(this.browser, slot, role);
		await this.browser.page('page_me', '/me/profile');
	}

	async step(): Promise<void> {
		if (this.attempt?.status === 'in_progress') return this.answer(PRACTICE_POLL_MS);
		const roll = Math.random();
		if (roll < 0.35) return this.startTest();
		if (roll < 0.55) {
			await this.browser.json('me_categories', 'GET', '/api/v1/me/categories', AnyBody);
			return;
		}
		if (roll < 0.7) {
			await this.browser.json('me_matches', 'GET', '/api/v1/me/matches', AnyBody);
			return;
		}
		await this.browser.page('page_me', pick(['/me/profile', '/me/category', '/me/tests', '/me/invitations']));
	}

	/** A test of any grade: in a demo session the order of grades and the retake interval are off. */
	async startTest(): Promise<void> {
		const body = { specialization: 'backend', grade: pick(GRADES) };
		this.attempt = expect(
			'test_start',
			await this.browser.json('test_start', 'POST', '/api/v1/me/tests', Attempt, body),
			201
		);
	}

	async state(attemptId: string): Promise<Attempt> {
		return expect(
			'test_state',
			await this.browser.json('test_state', 'GET', `/api/v1/me/tests/${attemptId}`, Attempt),
			200
		);
	}

	/** The cluster the attempt waits for, after reading the attempt again when it is not known. */
	async current(): Promise<{ attempt: Attempt; item: Attempt['items'][number] } | null> {
		let attempt = this.attempt;
		if (!attempt) return null;
		if (this.stale) {
			attempt = await this.state(attempt.id);
			this.attempt = attempt;
			this.stale = false;
		}
		const seq = attempt.current;
		const item = attempt.items.find((candidate) => candidate.seq === seq);
		if (item) return { attempt, item };
		this.attempt = await this.state(attempt.id);
		return null;
	}

	/** Answers the current cluster; practice goes to the sandbox and is waited for, as the screen waits for it. */
	async answer(pollMs: number): Promise<void> {
		const found = await this.current();
		if (!found) return;
		const { attempt, item } = found;
		let body: Record<string, unknown>;
		if (item.answer_kind === 'test_cases') body = { cases: [{ input: '1', expected: '1' }] };
		else if (item.practice) {
			body = {
				language: item.languages.includes('python3') ? 'python3' : (item.languages[0] ?? ''),
				source: 'print(0)\n'
			};
		} else if (item.answer_kind === 'set' || item.answer_kind === 'sequence') body = { answer: ['1'] };
		else body = { answer: '1' };
		if (item.change_step !== null && item.answers.length > 0) body = { change_step: body };
		const path = `/api/v1/me/tests/${attempt.id}/items/${item.seq}/answer`;
		if (!item.practice) {
			this.attempt = expect(
				'test_answer',
				await this.browser.json('test_answer', 'POST', path, TestStep, body),
				200
			).attempt;
			return;
		}
		const release = await sandboxSlot();
		try {
			const started = performance.now();
			const step = expect(
				'practice_submit',
				await this.browser.json('practice_submit', 'POST', path, TestStep, body),
				200
			);
			let state = step.attempt;
			while (state.waiting_sandbox && state.status === 'in_progress') {
				if (performance.now() - started > 600_000) throw new StandFailure('practice: no sandbox result in 10 minutes');
				await sleep(pollMs);
				state = await this.state(attempt.id);
			}
			const waited = performance.now() - started;
			practiceWaits.push(waited);
			record('practice_result', waited, 'ok');
			this.attempt = state;
		} finally {
			release();
		}
	}

	/** Starts an attempt and answers it up to its first practice task, which it leaves unanswered. */
	async toPractice(): Promise<void> {
		await this.startTest();
		for (let answered = 0; answered < 40; answered++) {
			const found = await this.current();
			if (found?.item.practice === true && found.item.answers.length === 0) return;
			if (this.attempt?.status !== 'in_progress') await this.startTest();
			else await this.answer(BURST_POLL_MS);
		}
		throw new Error('practice burst: no practice task in 40 clusters');
	}
}

/** Candidates of the mixed run: after the employers of a session, different heroes, the sessions starting in turn. */
const mixedCandidate = (index: number) => {
	const slot = Math.floor(index / USERS_PER_SESSION);
	const position = (index % USERS_PER_SESSION) - EMPLOYER_ROLES.length;
	return { slot, role: CANDIDATE_ROLES[(slot * 2 + position) % CANDIDATE_ROLES.length] ?? '' };
};

/** Candidates of the practice burst: the five heroes of each session, without employers. */
const burstCandidate = (index: number) => ({
	slot: Math.floor(index / CANDIDATE_ROLES.length),
	role: CANDIDATE_ROLES[index % CANDIDATE_ROLES.length] ?? ''
});

type User = Employer | Candidate;

const userErrors = new Map<string, number>();

async function runUser(user: User, index: number): Promise<void> {
	try {
		await user.start(index);
	} catch (cause) {
		const key = `start: ${cause instanceof Error ? cause.message : String(cause)}`;
		userErrors.set(key, (userErrors.get(key) ?? 0) + 1);
		return;
	}
	while (!stopping) {
		await think();
		if (isStopping()) break;
		try {
			await user.step();
		} catch (cause) {
			const key = cause instanceof Error ? cause.message.replace(/[0-9a-f-]{36}/gu, '<id>') : String(cause);
			userErrors.set(key, (userErrors.get(key) ?? 0) + 1);
			if (user instanceof Candidate) user.attempt = null;
		}
	}
}

// --- Report --------------------------------------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

interface OpReport {
	op: string;
	count: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	clientErrors: number;
	rateLimited: number;
	serverErrors: number;
	timeouts: number;
	network: number;
}

function summarize(list: Sample[]): OpReport[] {
	const byOp = new Map<string, Sample[]>();
	for (const s of list) byOp.set(s.op, [...(byOp.get(s.op) ?? []), s]);
	return [...byOp]
		.map(([op, ops]) => {
			const times = ops
				.filter((s) => s.outcome === 'ok' || s.outcome === 'client_error')
				.map((s) => s.ms)
				.sort((a, b) => a - b);
			const count = (outcome: Outcome) => ops.filter((s) => s.outcome === outcome).length;
			return {
				op,
				count: ops.length,
				p50: Math.round(percentile(times, 50)),
				p95: Math.round(percentile(times, 95)),
				p99: Math.round(percentile(times, 99)),
				max: Math.round(times.at(-1) ?? Number.NaN),
				clientErrors: count('client_error'),
				rateLimited: count('rate_limited'),
				serverErrors: count('server_error'),
				timeouts: count('timeout'),
				network: count('network')
			};
		})
		.sort((a, b) => a.op.localeCompare(b.op));
}

const isRequest = (s: Sample) => s.request !== null;

function errorRate(list: Sample[]): number {
	const requests = list.filter(isRequest);
	return requests.length === 0 ? 0 : requests.filter((s) => FAILED.has(s.outcome)).length / requests.length;
}

function printTable(title: string, rows: OpReport[]): void {
	console.log(`\n${title}`);
	console.log(
		'op'.padEnd(18) +
			['n', 'p50', 'p95', 'p99', 'max', '4xx', '429', '5xx', 't/o', 'net'].map((h) => h.padStart(7)).join('')
	);
	for (const r of rows) {
		console.log(
			r.op.padEnd(18) +
				[r.count, r.p50, r.p95, r.p99, r.max, r.clientErrors, r.rateLimited, r.serverErrors, r.timeouts, r.network]
					.map((v) => String(v).padStart(7))
					.join('')
		);
	}
}

// --- Run -----------------------------------------------------------------------------------------------------------

const startedAt = new Date();
const users: Promise<void>[] = [];
let started = 0;
const stageReports: {
	stage: number;
	users: number;
	requests: number;
	errorRate: number;
	rps: number;
	apiPerMinute: number;
}[] = [];

/**
 * The practice burst (`--practice-burst <n>`): n candidates bring an attempt each to its first practice task, then all
 * answer it at the same moment; the sandbox of the stand runs one program at a time, so the answers queue.
 */
async function practiceBurst(n: number): Promise<void> {
	currentStage = 1;
	const candidates = Array.from({ length: n }, () => new Candidate(burstCandidate));
	await Promise.all(candidates.map((candidate, index) => candidate.start(index)));
	await Promise.all(candidates.map((candidate) => candidate.toPractice()));
	console.log(`practice burst: ${n} candidates at a practice task, answering at once`);
	const firstSample = samples.length;
	await Promise.all(candidates.map((candidate) => candidate.answer(BURST_POLL_MS)));
	const burstSamples = samples.slice(firstSample);
	stageReports.push({
		stage: 1,
		users: n,
		requests: burstSamples.filter(isRequest).length,
		errorRate: errorRate(burstSamples),
		rps: Number.NaN,
		apiPerMinute: Number.NaN
	});
}

if (PRACTICE_BURST !== null) {
	await practiceBurst(PRACTICE_BURST);
} else {
	for (const [stageIndex, target] of STAGES.entries()) {
		currentStage = stageIndex + 1;
		const stageStart = performance.now();
		const firstSample = samples.length;
		while (started < target) {
			const index = started++;
			// Employers first in every session, then candidates: the share follows `--users-per-session`.
			const user: User =
				index % USERS_PER_SESSION < EMPLOYER_ROLES.length ? new Employer() : new Candidate(mixedCandidate);
			users.push(runUser(user, index));
			await sleep(250);
		}
		console.log(`stage ${currentStage}: ${target} users`);
		while (performance.now() - stageStart < STAGE_MS && !isStopping()) await sleep(1000);
		const stageSamples = samples.slice(firstSample);
		const rate = errorRate(stageSamples);
		const requests = stageSamples.filter(isRequest).length;
		const seconds = (performance.now() - stageStart) / 1000;
		const apiPerMinute = (stageSamples.filter((s) => s.request === 'api').length / seconds) * 60;
		stageReports.push({
			stage: currentStage,
			users: target,
			requests,
			errorRate: rate,
			rps: requests / seconds,
			apiPerMinute
		});
		console.log(
			`stage ${currentStage}: ${requests} requests (${(requests / seconds).toFixed(1)}/s, API ${apiPerMinute.toFixed(0)}/min), failed ${(rate * 100).toFixed(2)} %`
		);
		if (rate > MAX_ERROR_RATE) {
			stopReason = `stage ${currentStage}: failed requests ${(rate * 100).toFixed(2)} % > ${MAX_ERROR_RATE * 100} %`;
			break;
		}
	}
}
stopping = true;
await Promise.all(users);

const report = {
	origin: ORIGIN,
	startedAt: startedAt.toISOString(),
	endedAt: new Date().toISOString(),
	settings: {
		stages: STAGES,
		stageSeconds: STAGE_MS / 1000,
		usersPerSession: USERS_PER_SESSION,
		demoSessions: sessions.length,
		thinkMs: [THINK_MIN, THINK_MAX],
		modelParses: MODEL_PARSES,
		sandboxParallel: SANDBOX_PARALLEL
	},
	stopReason,
	stages: stageReports,
	operations: summarize(samples),
	byStage: STAGES.map((_, i) => ({ stage: i + 1, operations: summarize(samples.filter((s) => s.stage === i + 1)) })),
	errorRate: errorRate(samples),
	parse: { model: parseModes.model, rules: parseModes.rules, failures: Object.fromEntries(parseModes.failures) },
	sandbox: { peakParallel: sandboxPeak, results: practiceWaits.length, waitsMs: practiceWaits.map(Math.round) },
	userErrors: Object.fromEntries(userErrors)
};

for (const stage of report.byStage) printTable(`stage ${stage.stage}`, stage.operations);
printTable('whole run', report.operations);
console.log(`\nfailed requests: ${(report.errorRate * 100).toFixed(2)} %; demo sessions: ${sessions.length}`);
console.log(`need text parses: model ${parseModes.model}, rules ${parseModes.rules}`, report.parse.failures);
console.log(`sandbox: peak ${sandboxPeak} waiting at once, ${practiceWaits.length} results`);
if (userErrors.size > 0) console.log('user errors:', report.userErrors);
if (stopReason) console.log(`stopped early: ${stopReason}`);
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, '\t') + '\n');
