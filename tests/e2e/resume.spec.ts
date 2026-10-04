// The candidate's resume in the browser against the local infrastructure (`make infra`: PostgreSQL, Redis, SeaweedFS; the
// migrated database with the published taxonomy and legal documents). The file is uploaded through the page into the
// bucket; the background jobs are run here the way the worker runs them — the parse with a parser that answers for the
// uploaded bytes, the extraction without a model, so the page shows the simplified mode with rules.
import { createHash, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, desc, eq, lte } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth/password';
import { categorizationCompute } from '$lib/server/categorization/job';
import {
	candidates,
	consentEvents,
	documentExtractions,
	jobs,
	legalDocuments,
	passwordCredentials,
	resumeDocuments,
	users
} from '$lib/server/db/schema';
import type { Docparse, DocparseResult, ParseResponse } from '$lib/server/documents/docparse';
import type { JobHandler } from '$lib/server/jobs/handler';
import { createLogger } from '$lib/server/jobs/log';
import { completeJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { ModelAdapter } from '$lib/server/ml/adapter';
import { createResumeExtractHandler } from '$lib/server/resumes/extract-job';
import { createResumeParseHandler } from '$lib/server/resumes/parse-job';
import { codePointLength } from '$lib/text/offsets';

// `$env/dynamic/private`, which these modules need through `$lib/server/config`, only SvelteKit provides; the hook
// that resolves it for a plain Node test process is registered process-wide, ahead of every worker's first import
// (`playwright.config.ts`, `tests/e2e/helpers/register-server-env.js`).
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');
const { objectStore } = await import('$lib/server/storage/object-store');

const PASSWORD = 'e2e passphrase long';

// Forms are posted to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

test.afterAll(async () => {
	await closeDb();
});

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

/** An active adult candidate with a password, a verified address and the processing consent. */
async function seedCandidate(): Promise<{ email: string; candidateId: string }> {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-resume-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: 'Анна Тестова'
		})
		.returning();
	if (!user) throw new Error('user not inserted');
	await database
		.insert(passwordCredentials)
		.values({ userId: user.id, hash: await hashPassword(PASSWORD), changedAt: now });
	const [candidate] = await database
		.insert(candidates)
		.values({
			userId: user.id,
			status: 'active',
			searchStatus: 'active',
			preferences: {},
			phoneEnc: crypto.encrypt('+7 900 000-00-02', 'candidates.phone'),
			birthDate: '1996-05-20',
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified'
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	const [document] = await database
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, 'pd_processing'), lte(legalDocuments.publishedAt, now)))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!document) throw new Error('no published pd_processing document: run scripts/seed-legal.ts');
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: document.id,
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: new Date(now.getTime() - 3_600_000)
	});
	return { email, candidateId: candidate.id };
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');
}

// --- The resume and its reading ---------------------------------------------------------------------------------------

// Characters outside the BMP before the quotes: the offsets are code points, the browser indexes UTF-16 units.
const LINES: { text: string; kind: ParseResponse['blocks'][number]['kind'] }[] = [
	{ text: '🚀 Анна Тестова', kind: 'heading' },
	{ text: 'Опыт работы', kind: 'heading' },
	{ text: 'Март 2021 — настоящее время', kind: 'paragraph' },
	{ text: 'ООО «Пример Технолоджиз»', kind: 'paragraph' },
	{ text: 'Ведущий Python-разработчик', kind: 'paragraph' },
	{ text: '• 🐘 Сервисы на FastAPI и PostgreSQL', kind: 'list_item' },
	{ text: 'Навыки', kind: 'heading' },
	{ text: 'Python, Docker, Kubernetes', kind: 'paragraph' },
	{ text: 'Знание языков: Английский — B2', kind: 'paragraph' }
];
const RESUME_TEXT = LINES.map((line) => line.text).join('\n');

/** What the parser answers for these bytes: the lines as blocks, offsets in code points. */
function parsedResume(bytes: Uint8Array): ParseResponse {
	let start = 0;
	const blocks = LINES.map((line, index) => {
		const block = {
			id: `d-b${String(index + 1).padStart(3, '0')}`,
			page: null,
			kind: line.kind,
			column: null,
			start,
			end: start + codePointLength(line.text)
		};
		start = block.end + 1;
		return block;
	});
	return {
		schemaVersion: 'docparse/v1',
		extractor: { name: 'e2e-parser', version: '1.0.0' },
		input: {
			sha256: createHash('sha256').update(bytes).digest('hex'),
			sizeBytes: bytes.byteLength,
			detectedFormat: 'txt',
			pageCount: null
		},
		status: 'complete',
		text: RESUME_TEXT,
		blocks,
		flags: { ocrUsed: false, ocrPages: [], incompleteReasons: [], externalResourcesIgnored: false },
		stats: { durationMs: 1 }
	};
}

function parser(answer: (bytes: Uint8Array) => DocparseResult): Docparse {
	return { parse: ({ bytes }) => Promise.resolve(answer(bytes)) };
}

const noModel = new ModelAdapter({
	models: { extract: null, embed: null, rerank: null },
	modes: { current: () => Promise.resolve({ ok: true, value: 'on' }) },
	spaces: () => Promise.resolve(null)
});

/** Captures the queued job of the type for this input, as the worker would, and completes it with the handler. */
async function runJob<T extends 'resume.parse' | 'resume.extract' | 'categorization.compute'>(
	type: T,
	inputVersion: string,
	payload: ClaimedJob<T>['payload'],
	handler: JobHandler<T>
): Promise<void> {
	const database = db();
	const [captured] = await database
		.update(jobs)
		.set({ status: 'running', leaseOwner: 'e2e', leaseExpiresAt: new Date(Date.now() + 120_000), attempts: 1 })
		.where(and(eq(jobs.type, type), eq(jobs.inputVersion, inputVersion), eq(jobs.status, 'queued')))
		.returning();
	if (!captured) throw new Error(`no queued ${type} job for ${inputVersion}`);
	const job: ClaimedJob<T> = {
		id: captured.id,
		type,
		payload,
		inputVersion: captured.inputVersion,
		attempt: 1,
		maxAttempts: captured.maxAttempts,
		leaseOwner: 'e2e'
	};
	const result = await handler.run({
		job,
		db: database,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(database, job, result)).toBe('succeeded');
}

async function currentResumeId(candidateId: string): Promise<string> {
	const [row] = await db()
		.select({ id: resumeDocuments.id })
		.from(resumeDocuments)
		.where(and(eq(resumeDocuments.candidateId, candidateId), eq(resumeDocuments.isCurrent, true)));
	if (!row) throw new Error('the upload left no current resume');
	return row.id;
}

async function parse(candidateId: string, answer: (bytes: Uint8Array) => DocparseResult): Promise<string> {
	const resumeDocumentId = await currentResumeId(candidateId);
	const handler = createResumeParseHandler({ store: objectStore, parser: () => parser(answer) });
	await runJob('resume.parse', resumeDocumentId, { resume_document_id: resumeDocumentId }, handler);
	return resumeDocumentId;
}

async function extractByRules(resumeDocumentId: string): Promise<void> {
	const [extraction] = await db()
		.select({ id: documentExtractions.id })
		.from(documentExtractions)
		.where(eq(documentExtractions.resumeDocumentId, resumeDocumentId));
	if (!extraction) throw new Error('the parse left no extraction');
	const handler = createResumeExtractHandler({ adapter: () => noModel, now: () => new Date() });
	await runJob('resume.extract', extraction.id, { extraction_id: extraction.id }, handler);
}

/** Runs the categorization the extraction queued, so the profile shows the skills of the resume. */
async function categorize(candidateId: string): Promise<void> {
	const [queued] = await db()
		.select({ inputVersion: jobs.inputVersion })
		.from(jobs)
		.where(and(eq(jobs.dedupKey, `categorization:${candidateId}`), eq(jobs.status, 'queued')));
	if (!queued) throw new Error('the extraction queued no categorization');
	await runJob('categorization.compute', queued.inputVersion, { candidate_id: candidateId }, categorizationCompute);
}

async function upload(page: Page, name: string, content: string | Buffer): Promise<void> {
	await page.getByLabel('Файл резюме').setInputFiles({
		name,
		mimeType: 'application/octet-stream',
		buffer: typeof content === 'string' ? Buffer.from(content, 'utf8') : content
	});
	await page.getByRole('button', { name: 'Загрузить резюме' }).click();
}

test('a candidate uploads a resume, sees where every field comes from, checks and corrects it, and deletes it', async ({
	page
}) => {
	const hero = await seedCandidate();
	await signIn(page, hero.email);

	await page.goto('/me/resume');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Резюме');
	await expect(page.getByText('Резюме пока нет')).toBeVisible();
	await expectNoAxeViolations(page);

	// A file over the limit is refused before it is sent; a file the parser does not read is refused by its content.
	await page.getByLabel('Файл резюме').setInputFiles({
		name: 'big.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)
	});
	await expect(page.getByTestId('resume-upload').getByRole('alert')).toHaveText(
		'Файл больше 10 МиБ: загрузите файл меньшего размера'
	);
	await upload(page, 'archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]));
	await expect(page.getByTestId('resume-upload').getByRole('alert')).toHaveText(
		'Формат не поддерживается: загрузите PDF или DOCX'
	);
	await expect(page.getByTestId('resume-files')).toHaveCount(0);

	// The upload is stored and waits for its parse; the page asks again by itself while the file is read.
	await upload(page, 'Анна Тестова.txt', RESUME_TEXT);
	await expect(page.getByText('Резюме загружено.')).toBeVisible();
	const files = page.getByTestId('resume-uploads');
	await expect(files.locator('li[data-current="true"]')).toHaveAttribute('data-parse-status', 'pending');
	await expect(page.getByTestId('resume-progress')).toContainText('Читаем файл «Анна Тестова.txt»');

	const resumeDocumentId = await parse(hero.candidateId, (bytes) => ({ ok: true, value: parsedResume(bytes) }));
	// The page asks again every few seconds.
	await expect(files.getByText('Извлекаем поля')).toBeVisible({ timeout: 10_000 });
	await extractByRules(resumeDocumentId);

	// Read by rules: the simplified mode is stated, and every field shows its quote.
	const reading = page.getByTestId('resume-reading');
	await expect(reading).toHaveAttribute('data-mode', 'rules_only', { timeout: 10_000 });
	await expect(reading.getByText('Упрощённый режим без модели')).toBeVisible();
	await expect(page.getByTestId('resume-progress')).toHaveCount(0);
	const text = page.getByTestId('resume-text');
	await expect(text).toContainText('🐘 Сервисы на FastAPI и PostgreSQL');
	await expectNoAxeViolations(page);

	// The profile reflects the resume: its reading, the fields with their quotes, and the skills it counts toward,
	// each opening the very field it rests on.
	await categorize(hero.candidateId);
	await page.goto('/me/profile');
	const profileResume = page.getByTestId('profile-resume');
	await expect(profileResume).toContainText('Анна Тестова.txt');
	await expect(profileResume.getByTestId('resume-parse-status')).toHaveAttribute('data-status', 'parsed');
	await expect(profileResume.getByTestId('fact-card')).toHaveAttribute('aria-label', 'Резюме');
	await expect(profileResume.getByTestId('profile-resume-claim').filter({ hasText: 'Kubernetes' })).toBeVisible();
	await profileResume.getByRole('button', { name: /^«Kubernetes»/ }).click();
	const profileText = profileResume.getByTestId('resume-text');
	const profileSelected = profileText.locator('mark[data-selected="true"]');
	await expect(profileSelected).toHaveText(['Kubernetes']);
	await expect(profileSelected).toBeFocused();
	// A skill of the resume opens its mention: the words of that quote are selected in the text, not the whole resume.
	const skills = page.getByTestId('skill-list');
	const dockerSkill = skills.locator('li[data-skill="docker"]');
	await dockerSkill.getByText(/^Откуда:/).click();
	const mention = dockerSkill.getByRole('link', { name: 'Резюме: «Docker»' });
	const target = await mention.getAttribute('href');
	expect(target).toMatch(/^#resume-claim-[0-9a-f-]{36}$/);
	await mention.click();
	await expect(profileSelected).toHaveText(['Docker']);
	await expect(profileSelected).toBeFocused();
	await expect(profileSelected).toBeInViewport();
	await expect(page.locator(target ?? '')).toHaveAttribute('data-skill', 'docker');
	// Every source a skill names has its place on the page: a field of the resume or a fact.
	const anchors = await skills
		.locator('a[href^="#"]')
		.evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
	expect(anchors.length).toBeGreaterThan(0);
	for (const anchor of anchors) await expect(page.locator(anchor)).toHaveCount(1);
	// The address of a field selects its quote when the page opens with it.
	await page.goto(`/me/profile${target ?? ''}`);
	await expect(profileSelected).toHaveText(['Docker']);
	await expectNoAxeViolations(page);
	await page.goto('/me/resume');

	// A click on a quote selects exactly its words in the text, after the characters outside the BMP.
	await page.getByRole('button', { name: /^«FastAPI»/ }).click();
	const selected = text.locator('mark[data-selected="true"]');
	await expect(selected).toHaveText(['FastAPI']);
	await expect(selected).toBeFocused();
	// A stated level of English also asserts the skill «Английский язык» of the taxonomy, quoted by the word
	// «Английский»; the language line is selected whole, across the mark of that shorter quote.
	await expect(
		page.getByTestId('resume-claims').getByRole('article', { name: 'Навык: Английский язык' })
	).toBeVisible();
	await page
		.getByRole('article', { name: 'Язык: Английский — B2' })
		.getByRole('button', { name: /^«Английский — B2»/ })
		.click();
	await expect(selected).toHaveText(['Английский — B2']);

	// The experience entry rests on several quotes; they are selected together.
	const entry = page.getByTestId('resume-entry');
	await expect(entry).toHaveCount(1);
	await expect(entry.getByRole('heading', { level: 3 })).toHaveText('Ведущий Python-разработчик');
	await expect(entry).toContainText('ООО «Пример Технолоджиз»');
	await expect(entry).toContainText(/март 2021.* — по настоящее время/);
	await entry.getByRole('button', { name: 'Показать в тексте резюме «Ведущий Python-разработчик»' }).click();
	await expect(selected).toContainText(['Март 2021 — настоящее время', 'ООО «Пример Технолоджиз»']);

	// Confirm one skill, reject another.
	const fields = page.getByTestId('resume-claims');
	const kubernetes = fields.getByRole('article', { name: 'Навык: Kubernetes' });
	await kubernetes.getByRole('button', { name: 'Подтвердить «Kubernetes»' }).click();
	await expect(kubernetes).toHaveAttribute('data-review', 'confirmed');
	await expect(kubernetes.getByText('Подтверждено')).toBeVisible();
	const docker = fields.getByRole('article', { name: 'Навык: Docker' });
	await docker.getByRole('button', { name: 'Отклонить «Docker»' }).click();
	await expect(docker).toHaveAttribute('data-review', 'rejected');
	await expect(docker.getByRole('button', { name: 'Вернуть «Docker»' })).toBeVisible();

	// Correct the period of the job: a wrong date is explained, a right one replaces the extracted one.
	await entry.getByRole('button', { name: 'Поправить «Ведущий Python-разработчик»' }).click();
	await entry.getByLabel('Начало').fill('март');
	await entry.getByRole('button', { name: 'Сохранить' }).click();
	await expect(entry.getByText('Год (2021) или год и месяц (2021-03)')).toBeVisible();
	await entry.getByLabel('Начало').fill('2021-02');
	await entry.getByRole('button', { name: 'Сохранить' }).click();
	await expect(entry).toHaveAttribute('data-review', 'edited');
	await expect(entry).toContainText(/февраль 2021.* — по настоящее время/);
	await expect(entry.getByLabel('Начало')).toHaveCount(0);
	await expectNoAxeViolations(page);

	// Deleting asks first and removes the resume with everything extracted from it.
	await files.getByRole('button', { name: 'Удалить резюме «Анна Тестова.txt»' }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toContainText('категория пересчитается');
	await expectNoAxeViolations(page);
	await dialog.getByRole('button', { name: 'Удалить насовсем' }).click();
	await expect(page.getByText('Резюме удалено вместе со всем, что из него извлечено.')).toBeVisible();
	await expect(page.getByText('Резюме пока нет')).toBeVisible();
	await expect(page.getByTestId('resume-uploads').locator('li')).toHaveCount(0);
});

test('a resume the parser could not read says why', async ({ page }) => {
	const hero = await seedCandidate();
	await signIn(page, hero.email);

	await page.goto('/me/resume');
	await upload(page, 'scan.txt', 'Резюме без текстового слоя');
	await expect(page.getByTestId('resume-progress')).toBeVisible();
	await parse(hero.candidateId, () => ({
		ok: false,
		error: { code: 'no_text', retryable: false, message: 'no text layer' }
	}));

	await expect(page.getByTestId('resume-progress')).toHaveCount(0, { timeout: 10_000 });
	await expect(page.getByTestId('resume-uploads').locator('li[data-current="true"]')).toHaveAttribute(
		'data-parse-status',
		'failed'
	);
	await expect(page.getByRole('alert')).toHaveText(
		'В файле не найден текст: загрузите файл с текстовым слоем или более чёткий скан'
	);
	await expectNoAxeViolations(page);
});
