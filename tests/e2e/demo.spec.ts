// The visitor's way into the demonstration stand, in the browser against the local infrastructure (`make infra`:
// PostgreSQL, Redis, SeaweedFS, `docparse`). A stand in demonstration mode needs a database of its own seeded with the
// demo data and a simulator whose dataset the seed generates, so this file makes them: a fresh database next to the one
// of the other tests, a private simulator, the start-up scripts and the demo seed of the command line, then the built
// application in demonstration mode on its own port. Visitors choose a role on `/demo`: each browser gets its own
// demo session with the clones of the cast, a link opens the same session in another browser, the administrator's
// shared switches are closed with an explanation, a visitor's own resume goes in with its separate consent, the
// cabinet of a clone says when its session goes, the clone of an athlete showing FSP as linked, the clone of a
// competition partner finds in its pool the finalists who consented to the original, the letters the session sent
// are read on its letters page, their links working, an athlete without an account of the seed signs in with FSP ID
// within the visitor's own demo session, and two visitors register a company with the same taxpayer number, each in
// their own session.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { DEMO_STAND_PORT } from './helpers/ports';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '$lib/server/db/schema';
import {
	auditEvents,
	candidates,
	companies,
	consentEvents,
	demoLetters,
	demoSessions,
	externalIdentities,
	files,
	representations,
	users
} from '$lib/server/db/schema';
import { S3ObjectStore } from '$lib/server/storage/object-store';
import { DEFAULT_SEED } from '../../services/fsp-mock/src/config.ts';
import { FSP_MOCK_CREDENTIALS, startFspMock, type FspMock } from '../helpers/fsp-mock';

// Its own port (helpers/ports.ts): the application of the other tests and the stand-in of the public profile APIs have
// theirs, and the files run in parallel.
const PORT = DEMO_STAND_PORT;
const ORIGIN = `http://localhost:${PORT}`;
const ATHLETES = 200;

process.loadEnvFile('.env');
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error('DATABASE_URL must be set in .env');

const name = `e2e_demo_${randomBytes(5).toString('hex')}`;
const databaseUrl = (() => {
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	return url.toString();
})();

let mock: FspMock | undefined;
let server: ChildProcess | undefined;
let client: postgres.Sql | undefined;
const serverLog: string[] = [];

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: ORIGIN });

/** The environment of the stand under test: `.env` with this file's database, simulator and demonstration mode. */
function standEnvironment(): NodeJS.ProcessEnv {
	if (!mock) throw new Error('the simulator of the demo stand is not started');
	return {
		...process.env,
		NODE_OPTIONS: '',
		DATABASE_URL: databaseUrl,
		APP_ORIGIN: ORIGIN,
		ORIGIN,
		HOST: '127.0.0.1',
		PORT: String(PORT),
		BODY_SIZE_LIMIT: '11M',
		// As for the application of the other tests (playwright.config.ts): each test is a visitor of its own address.
		ADDRESS_HEADER: 'X-Forwarded-For',
		XFF_DEPTH: '1',
		DEMO_MODE: 'true',
		DEMO_CANDIDATES: '40',
		DEMO_VACANCIES: '30',
		FSP_MOCK_SEED: DEFAULT_SEED,
		FSP_MOCK_ATHLETES: String(ATHLETES),
		FSP_MOCK_CONTROL_TOKEN: FSP_MOCK_CREDENTIALS.controlToken,
		FSP_ID_ISSUER: mock.issuer,
		FSP_ID_CLIENT_ID: FSP_MOCK_CREDENTIALS.clientId,
		FSP_ID_CLIENT_SECRET: FSP_MOCK_CREDENTIALS.clientSecret,
		FSP_ID_REDIRECT_URI: `${ORIGIN}/auth/fsp/callback`,
		FSP_ACHIEVEMENTS_ADAPTER: 'mock',
		FSP_ACHIEVEMENTS_BASE_URL: mock.origin,
		FSP_ASSERTION_SECRET: FSP_MOCK_CREDENTIALS.assertionSecret,
		FSP_WEBHOOK_SECRET: FSP_MOCK_CREDENTIALS.webhookSecret,
		// The simulator of this file answers on 127.0.0.1; the proxy of the environment must not see it.
		NO_PROXY: '*'
	};
}

async function run(command: string, args: string[]): Promise<void> {
	const child = spawn(command, args, { env: standEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
	const output: string[] = [];
	child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
	child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
	const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
	if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${code}: ${output.join('').slice(-4000)}`);
}

async function portOpen(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port: PORT });
		socket.once('connect', () => {
			socket.end();
			resolve(true);
		});
		socket.once('error', () => {
			resolve(false);
		});
	});
}

/** Stops the stand's server: SIGTERM, SIGKILL when it has not exited in 10 seconds. */
async function stopServer(): Promise<void> {
	const running = server;
	server = undefined;
	if (!running || running.exitCode !== null || running.signalCode !== null) return;
	const exited = new Promise((resolve) => running.once('exit', resolve));
	running.kill('SIGTERM');
	const kill = setTimeout(() => running.kill('SIGKILL'), 10_000);
	await exited;
	clearTimeout(kill);
}

test.beforeAll(async () => {
	test.setTimeout(600_000);
	// A stand left by an interrupted run would take the port: the new one would die of EADDRINUSE and the tests would
	// talk to the old one.
	if (await portOpen()) {
		throw new Error(
			`port ${PORT} of the demo stand is taken before its start, probably by the stand of an interrupted run: ` +
				`stop the process that \`ss -ltnp 'sport = :${PORT}'\` names`
		);
	}
	const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
	try {
		await admin.unsafe(`create database ${name}`);
	} finally {
		await admin.end({ timeout: 5 });
	}
	client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
	mock = await startFspMock({ athletes: ATHLETES, redirectUri: `${ORIGIN}/auth/fsp/callback` });
	for (const script of ['migrate', 'seed-taxonomy', 'seed-legal', 'seed-policies', 'seed-assessments']) {
		await run(process.execPath, [`scripts/${script}.ts`]);
	}
	await run('pnpm', ['demo:build']);
	await run(process.execPath, ['--enable-source-maps', 'build/demo/main.js', 'seed']);

	server = spawn(process.execPath, ['build/index.js'], { env: standEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
	server.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString('utf8')));
	server.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString('utf8')));
	const deadline = Date.now() + 60_000;
	while (!(await portOpen())) {
		if (server.exitCode !== null || Date.now() > deadline) {
			const log = serverLog.join('').slice(-4000);
			await stopServer();
			throw new Error(`the demo stand did not start: ${log}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
});

// Runs after a failed start as well: whatever the start made is taken down, the server first.
test.afterAll(async () => {
	await stopServer();
	if (client) {
		// Objects of the seed and of the clones live in the bucket shared with the other tests.
		const store = new S3ObjectStore({
			endpoint: process.env.S3_ENDPOINT ?? '',
			region: process.env.S3_REGION ?? '',
			accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
			bucket: process.env.S3_BUCKET ?? ''
		});
		const keys = await client`select storage_key from files`;
		for (const row of keys) await store.delete(String(row.storage_key));
		await client.end({ timeout: 5 });
	}
	await mock?.stop();
	const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
	try {
		await admin.unsafe(`drop database if exists ${name} with (force)`);
	} finally {
		await admin.end({ timeout: 5 });
	}
});

const database = () => {
	if (!client) throw new Error('the database of the demo stand is not created');
	return drizzle({ client, schema, casing: 'snake_case' });
};

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

async function enter(page: Page, role: string): Promise<void> {
	await page.locator(`[data-role="${role}"]`).getByRole('button', { name: /Войти/ }).click();
}

/** The join link of the page's demo session, as `/demo` shows it. */
async function joinLinkOf(page: Page): Promise<string> {
	await page.goto('/demo');
	return page.getByLabel(/Ссылка, чтобы открыть эту же сессию/).inputValue();
}

/** The demo session of the page, found by the join token of its link. */
async function demoSessionOf(page: Page): Promise<string> {
	const token = new URL(await joinLinkOf(page)).searchParams.get('join');
	if (!token) throw new Error('the join link carries no token');
	const [row] = await database()
		.select({ id: demoSessions.id })
		.from(demoSessions)
		.where(eq(demoSessions.joinTokenSha256, createHash('sha256').update(token, 'utf8').digest('hex')));
	if (!row) throw new Error('the join link opens no demo session');
	return row.id;
}

test('a visitor chooses a role and acts in a demo session of their own', async ({ browser }) => {
	const first = await (await browser.newContext()).newPage();
	await first.goto('/demo');
	await expect(first.getByRole('heading', { name: 'Демо-сессия', level: 1 })).toBeVisible();
	await expect(first.locator('[data-role]')).toHaveCount(11);
	await expectNoAxeViolations(first);

	await enter(first, 'candidate:k5');
	await first.waitForURL(/\/me/);
	const firstLink = await joinLinkOf(first);
	await expect(first.getByTestId('demo-session')).toContainText('Удалится через');
	await expect(first.locator('[data-role="candidate:k5"]')).toContainText('вы здесь');

	// Another browser gets another session with its own clones.
	const second = await (await browser.newContext()).newPage();
	await second.goto('/demo');
	await enter(second, 'candidate:k5');
	await second.waitForURL(/\/me/);
	const secondLink = await joinLinkOf(second);
	expect(secondLink).not.toBe(firstLink);
	const sessions = await database().select({ id: demoSessions.id }).from(demoSessions);
	expect(sessions).toHaveLength(2);
	const clones = await database().select({ id: users.id }).from(users).where(isNotNull(users.demoSessionId));
	expect(clones).toHaveLength(22);

	// The link opens the first session in a third browser: the employer of the same scenario.
	const third = await (await browser.newContext()).newPage();
	await third.goto(firstLink.replace(/^https?:\/\/[^/]+/, ''));
	await expect(third.getByTestId('demo-session')).toBeVisible();
	await enter(third, 'member:severny_kod_recruiter');
	await third.waitForURL(/\/company/);
	expect(await joinLinkOf(third)).toBe(firstLink);
});

test('the clone of a competition partner finds the finalists who consented to its original', async ({ browser }) => {
	const poolSize = async () => {
		const page = await (await browser.newContext()).newPage();
		await page.goto('/demo');
		await enter(page, 'member:teply_stek_recruiter');
		await page.waitForURL(/\/company/);
		// The only open partnership of the company leads straight to its pool.
		await page.goto('/company/partner-pools');
		await expect(page).toHaveURL(/\/company\/partner-pools\/[0-9a-f-]{36}$/);
		const members = page.getByTestId('pool-members').locator('[data-pool-candidate]');
		await expect(members.first()).toBeVisible();
		return members.count();
	};
	// Each visitor's session has its own clone of the partner, and each sees the same pool.
	const first = await poolSize();
	expect(first).toBeGreaterThan(0);
	expect(await poolSize()).toBe(first);
});

test('a clone of an athlete shows FSP as linked, and the header says when the session goes', async ({ browser }) => {
	const page = await (await browser.newContext()).newPage();
	await page.goto('/demo');
	await enter(page, 'candidate:k1');
	await page.waitForURL(/\/me/);
	await expect(page.getByTestId('demo-session-badge').first()).toHaveText(/Демо-сессия, удалится через \d+ ч \d+ мин/);
	await expectNoAxeViolations(page);

	await page.goto('/account');
	await expect(page.getByTestId('fsp-section')).toContainText('Достижения импортируются из ФСП');
	await expect(page.getByRole('link', { name: 'Подтвердить достижения из ФСП' })).toHaveCount(0);

	// Every opening of a session is in the journal.
	const opened = await database()
		.select({ id: auditEvents.objectId })
		.from(auditEvents)
		.where(eq(auditEvents.action, 'demo.session_opened'));
	const sessions = await database().select({ id: demoSessions.id }).from(demoSessions);
	expect(opened.map((row) => row.id).sort()).toEqual(sessions.map((row) => row.id).sort());
});

test('the administrator of a demo session sees the shared switches closed', async ({ browser }) => {
	const page = await (await browser.newContext()).newPage();
	await page.goto('/demo');
	await enter(page, 'staff:admin');
	await page.waitForURL(/\/admin/);
	await expect(page.getByTestId('demo-lock')).toContainText('В демо недоступно');
	await expect(page.getByRole('switch')).toHaveCount(0);
	await expectNoAxeViolations(page);

	// Staff roles are shared too; the list holds the accounts of this demo session only.
	await page.goto('/admin/staff');
	await expect(page.getByTestId('demo-lock')).toContainText('Роли персонала общие');
	await expect(page.getByRole('button', { name: 'Снять роль' })).toHaveCount(0);
	const session = await demoSessionOf(page);
	await page.goto('/admin/staff');
	const staff = await page
		.getByTestId('staff')
		.locator('[data-staff]')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-staff') ?? ''));
	expect(staff.length).toBeGreaterThan(0);
	const sessions = await database()
		.select({ session: users.demoSessionId })
		.from(users)
		.where(inArray(users.id, staff));
	expect(new Set(sessions.map((row) => row.session))).toEqual(new Set([session]));
	await expectNoAxeViolations(page);
});

test('the FSP operator of a demo session loads no batch of FSP results', async ({ browser }) => {
	const page = await (await browser.newContext()).newPage();
	await page.goto('/demo');
	await enter(page, 'staff:operator');
	await page.waitForURL(/\/operator/);
	await page.goto('/operator/fsp-import');
	await expect(page.getByTestId('demo-lock')).toContainText('проверка и загрузка пакета закрыты');
	await expect(page.getByLabel(/Файл/)).toHaveCount(0);
	await expectNoAxeViolations(page);
});

test('a clone is signed out once its demo session is over', async ({ browser }) => {
	const page = await (await browser.newContext()).newPage();
	await page.goto('/demo');
	await enter(page, 'candidate:k3');
	await page.waitForURL(/\/me/);
	const session = await demoSessionOf(page);
	await page.goto('/me');
	await expect(page.getByTestId('demo-session-badge').first()).toBeVisible();
	// The end of the session has passed; `demo.purge` has not removed it yet.
	await database()
		.update(demoSessions)
		.set({ expiresAt: sql`${demoSessions.createdAt} + interval '1 millisecond'` })
		.where(eq(demoSessions.id, session));
	await page.goto('/me');
	await page.waitForURL(/\/login/);
});

test('a visitor uploads a resume of their own with its separate consent', async ({ browser }) => {
	const page = await (await browser.newContext()).newPage();
	await page.goto('/demo');
	await enter(page, 'candidate:k2');
	await page.waitForURL(/\/me/);
	await page.goto('/demo/resume');
	await expect(page.getByTestId('document-body')).toContainText('24 часа');
	await expectNoAxeViolations(page);
	await page.getByLabel('Файл резюме').setInputFiles({
		name: 'cv.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('Иван Судейский\n\nPython-разработчик, 2019–2024.\n\nНавыки: Python, PostgreSQL.')
	});
	await page.getByRole('checkbox').check();
	await page.getByRole('button', { name: 'Согласиться и загрузить' }).click();
	await page.waitForURL(/\/me\/resume/);

	const consents = await database()
		.select({ user: consentEvents.signerUserId })
		.from(consentEvents)
		.where(eq(consentEvents.kind, 'demo_resume_upload'));
	expect(consents).toHaveLength(1);
	const [owner] = await database()
		.select({ session: users.demoSessionId })
		.from(users)
		.where(eq(users.id, consents[0]?.user ?? ''));
	const [session] = await database()
		.select({ ownResumeAt: demoSessions.ownResumeAt })
		.from(demoSessions)
		.where(eq(demoSessions.id, owner?.session ?? ''));
	expect(session?.ownResumeAt).not.toBeNull();
	const uploaded = await database()
		.select({ key: files.storageKey })
		.from(files)
		.where(eq(files.ownerUserId, consents[0]?.user ?? ''));
	expect(uploaded.length).toBeGreaterThan(0);
});

test('the letters of a demo session are read on its letters page, and their links work', async ({ browser }) => {
	const page = await (await browser.newContext()).newPage();
	await page.goto('/demo');
	await enter(page, 'staff:operator');
	await page.waitForURL(/\/operator/);
	const session = await demoSessionOf(page);

	// The operator of the session verifies the authority of the teenager's representative: a letter goes to them.
	const [waiting] = await database()
		.select({ id: representations.id })
		.from(representations)
		.innerJoin(candidates, eq(candidates.id, representations.candidateId))
		.where(and(eq(candidates.demoSessionId, session), ne(representations.status, 'ended')));
	if (!waiting) throw new Error('the demo session has no representation of a teenager');
	await page.goto(`/operator/representatives/${waiting.id}`);
	await page.getByLabel('Минимальное основание').selectOption('birth_certificate');
	await page.getByRole('button', { name: 'Подтвердить полномочия' }).click();
	await expect(page).toHaveURL(/decided=verified/);

	await page.getByTestId('demo-mail-link').click();
	await page.waitForURL(/\/demo\/mail$/);
	await expect(page.getByRole('heading', { name: 'Письма сессии', level: 1 })).toBeVisible();
	// The teenager's notice about the decision would be a letter: a clone has no channel of its own.
	await expect(page.locator('[data-testid="demo-letter"][data-status="not_delivered"]')).toContainText(
		'Полномочия представителя подтверждены'
	);
	const letter = page.locator('[data-testid="demo-letter"][data-status="sent"]');
	await expect(letter).toHaveCount(1);
	await expect(letter).toContainText('Законному представителю');
	await expectNoAxeViolations(page);

	await letter.click();
	await expect(page.getByTestId('demo-letter-recipient')).toContainText('***@');
	await expectNoAxeViolations(page);
	const link = page.getByTestId('demo-letter-link').first();
	await expect(link).toHaveAttribute('href', /\/representative\/consent\?token=/);
	await link.click();
	await expect(page.getByTestId('representative-consents').locator('[data-consent]')).toHaveCount(3);

	// Another session does not see the letter.
	const [kept] = await database()
		.select({ id: demoLetters.id })
		.from(demoLetters)
		.where(eq(demoLetters.demoSessionId, session));
	if (!kept) throw new Error('the letter is not kept with the session');
	const other = await (await browser.newContext()).newPage();
	await other.goto('/demo');
	await enter(other, 'staff:operator');
	await other.waitForURL(/\/operator/);
	const answer = await other.goto(`/demo/mail/${kept.id}`);
	expect(answer?.status()).toBe(404);
});

test('an athlete signs in with FSP ID from scratch within each visitor’s own demo session', async ({ browser }) => {
	const athlete = await mock?.heroId('Длинная история');
	if (!athlete) throw new Error('the simulator has no athlete «Длинная история»');

	/** «Войти через ФСП ID» with the athlete, the registration form, and the account the browser ends up in. */
	const signUp = async (page: Page) => {
		await page.goto('/login');
		await page.getByRole('button', { name: 'Войти через ФСП ID' }).click();
		await expect(page.getByRole('heading', { name: 'Вход в ФСП ID' })).toBeVisible();
		await page.getByRole('button', { name: /Длинная история/ }).click();
		await page.waitForURL(/\/register$/);
		await expect(page.getByLabel('Как к вам обращаться')).not.toHaveValue('');
		await page.getByLabel('Дата рождения').fill('2002-05-10');
		await page.getByRole('checkbox', { name: /Принимаю/ }).check();
		await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
		await page.waitForURL(/\/onboarding/);
		await expect(page.getByTestId('demo-session-badge').first()).toBeVisible();
		return demoSessionOf(page);
	};

	const first = await signUp(await (await browser.newContext()).newPage());
	const second = await signUp(await (await browser.newContext()).newPage());
	expect(second).not.toBe(first);
	// One account of the athlete in each session, none outside sessions.
	const accounts = await database()
		.select({ user: externalIdentities.userId, session: externalIdentities.demoSessionId })
		.from(externalIdentities)
		.where(eq(externalIdentities.subject, athlete));
	expect(accounts.map((row) => row.session).sort()).toEqual([first, second].sort());
	const owners = await database()
		.select({ session: users.demoSessionId, batch: users.seedBatchId })
		.from(users)
		.where(
			inArray(
				users.id,
				accounts.map((row) => row.user)
			)
		);
	expect(owners.map((row) => row.session).sort()).toEqual([first, second].sort());
	expect(owners.every((row) => row.batch === null)).toBe(true);
});

/** A 10-digit taxpayer number of an organization with valid check digits. */
function organizationInn(): string {
	const digits = Array.from(randomBytes(9), (byte, index) => (index === 0 ? 1 + (byte % 9) : byte % 10));
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const sum = digits.reduce((total, digit, index) => total + digit * (weights[index] ?? 0), 0);
	return [...digits, (sum % 11) % 10].join('');
}

test('two visitors register a company with the same taxpayer number, each in their own demo session', async ({
	browser
}) => {
	const inn = organizationInn();

	/** The registration of an employer by password, and the demo session the browser ends up in. */
	const registerEmployer = async (page: Page) => {
		await page.goto('/register');
		await page.getByRole('radio', { name: /Нанимаю/ }).check();
		await page.getByLabel('Ваше имя').fill('Ирина Кадрова');
		await page.getByLabel('Рабочая почта').fill(`hr-${randomBytes(6).toString('hex')}@example.org`);
		await page.getByLabel('Пароль').fill('correct horse battery staple');
		await page.getByLabel('Название компании').fill('ООО «Один ИНН»');
		await page.getByLabel('ИНН компании').fill(inn);
		for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
		await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
		// The address of an account of a session is confirmed, and an employer has no other step: the cabinet opens.
		await expect(page).toHaveURL(/\/account$/);
		await expect(page.getByTestId('demo-session-badge').first()).toBeVisible();
		return demoSessionOf(page);
	};

	const first = await registerEmployer(await (await browser.newContext()).newPage());
	const second = await registerEmployer(await (await browser.newContext()).newPage());
	expect(second).not.toBe(first);
	const withNumber = await database()
		.select({ session: companies.demoSessionId })
		.from(companies)
		.where(eq(companies.inn, inn));
	expect(withNumber.map((row) => row.session).sort()).toEqual([first, second].sort());

	// The clones of the companies of the cast keep the numbers of their originals.
	const clones = await database()
		.select({ inn: companies.inn, original: companies.demoCloneOf })
		.from(companies)
		.where(and(eq(companies.demoSessionId, first), isNotNull(companies.demoCloneOf)));
	expect(clones.length).toBeGreaterThan(0);
	for (const clone of clones) {
		if (!clone.original) throw new Error('a clone without its original');
		const [original] = await database()
			.select({ inn: companies.inn })
			.from(companies)
			.where(eq(companies.id, clone.original));
		expect(clone.inn).toBe(original?.inn);
	}
});
