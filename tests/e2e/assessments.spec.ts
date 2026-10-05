// Platform tests in the browser against the local infrastructure (`make infra`, migrated database with the published
// taxonomy, legal documents, product policies and assessment bank from the webServer seed (playwright.config.ts):
// `scripts/seed-legal.ts`, `scripts/seed-policies.ts` and `scripts/seed-assessments.ts`. The candidate passes the
// adaptive quiz and finds the result in the profile after the evidence job; a practical task is submitted and waits in the queue — the sandbox is not part of the e2e
// stand, so its run is covered by `tests/integration/assessments-sandbox.test.ts`.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, desc, eq, lte } from 'drizzle-orm';
import { readAssessmentBank, type BankEntry } from '$lib/server/assessments/bank';
import { evidenceCompute } from '$lib/server/evidence/job';
import { hashPassword } from '$lib/server/auth/password';
import {
	assessmentArtifacts,
	candidates,
	consentEvents,
	jobs,
	legalDocuments,
	passwordCredentials,
	users
} from '$lib/server/db/schema';
import { createLogger } from '$lib/server/jobs/log';
import { completeJob, type ClaimedJob } from '$lib/server/jobs/queue';

// `$env/dynamic/private`, which these modules need through `$lib/server/config`, only SvelteKit provides; the hook
// that resolves it for a plain Node test process is registered process-wide, ahead of every worker's first import
// (`playwright.config.ts`, `tests/e2e/helpers/register-server-env.js`).
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');

const PASSWORD = 'e2e passphrase long';
const BANK_DIR = fileURLToPath(new URL('../../assessments', import.meta.url));

test.use({ baseURL: APP_ORIGIN });

let bank: BankEntry[];

test.beforeAll(async () => {
	// The bank content is read here only for the assertions below; the webServer seed already published it.
	bank = await readAssessmentBank(BANK_DIR);
});

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
	const email = `e2e-tests-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: 'Мария Тестова'
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
			phoneEnc: crypto.encrypt('+7 900 000-00-01', 'candidates.phone'),
			birthDate: '1999-03-14',
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

/** Runs the evidence computation the quiz enqueued, the way the worker does. */
async function runQueuedEvidence(candidateId: string): Promise<void> {
	const database = db();
	const [captured] = await database
		.update(jobs)
		.set({ status: 'running', leaseOwner: 'e2e', leaseExpiresAt: new Date(Date.now() + 120_000), attempts: 1 })
		.where(and(eq(jobs.dedupKey, `evidence:${candidateId}`), eq(jobs.status, 'queued')))
		.returning();
	if (!captured) throw new Error('the quiz did not enqueue the evidence computation');
	const job: ClaimedJob<'evidence.compute'> = {
		id: captured.id,
		type: 'evidence.compute',
		payload: { candidate_id: candidateId },
		inputVersion: captured.inputVersion,
		attempt: 1,
		maxAttempts: captured.maxAttempts,
		leaseOwner: 'e2e'
	};
	const result = await evidenceCompute.run({
		job,
		db: database,
		signal: new AbortController().signal,
		requestId: `job:${job.id}`,
		log: createLogger({}, () => undefined)
	});
	expect(await completeJob(database, job, result)).toBe('succeeded');
}

function quizOf(key: string) {
	const entry = bank.find((candidate) => candidate.key === key);
	if (entry?.itemBank.type !== 'adaptive_quiz') throw new Error(`${key} is not a quiz`);
	return entry.itemBank;
}

test('a candidate passes the adaptive quiz and finds the confirmed skill in the profile', async ({ page }) => {
	const hero = await seedCandidate();
	await signIn(page, hero.email);

	// The catalog: practical tasks and quizzes, each with its coverage and the honest note.
	await page.goto('/me/tests');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Тесты платформы');
	await expect(page.getByTestId('code-tasks').getByTestId('honest-note')).toContainText(
		'не доказательство самостоятельного выполнения'
	);
	// A quiz runs no code: its note names no sandbox.
	await expect(page.getByTestId('quizzes').getByTestId('honest-note')).toContainText('Засчитанный квиз');
	await expect(page.getByTestId('quizzes').getByTestId('honest-note')).not.toContainText('песочниц');
	const count = (kind: BankEntry['kind']) => bank.filter((entry) => entry.kind === kind).length;
	await expect(page.getByTestId('code-tasks').getByTestId('assessment-card')).toHaveCount(count('code_task'));
	await expect(page.getByTestId('quizzes').getByTestId('assessment-card')).toHaveCount(count('quiz'));
	await expect(page.getByTestId('quizzes').getByRole('link', { name: 'TypeScript: система типов' })).toBeVisible();
	await expectNoAxeViolations(page);

	// The quiz: coverage before the start, then questions one by one.
	await page.getByRole('link', { name: 'Python: язык и модель выполнения' }).click();
	await expect(page.getByTestId('before-start').getByTestId('coverage-not-checked')).toContainText('коммерческий опыт');
	await expectNoAxeViolations(page);
	await page.getByRole('button', { name: 'Начать попытку' }).click();

	const quiz = quizOf('quiz-python');
	let answered = 0;
	const result = page.getByTestId('attempt-result');
	while (!(await result.isVisible())) {
		if (answered >= 12) throw new Error('the quiz did not end in 12 answers');
		const question = page.getByTestId('quiz-question');
		await expect(question.getByRole('heading', { name: `Вопрос ${answered + 1}` })).toBeVisible();
		if (answered === 0) await expectNoAxeViolations(page);
		const itemId = await question.locator('input[name="itemId"]').inputValue();
		const item = quiz.items.find((candidate) => candidate.id === itemId);
		if (!item) throw new Error(`question ${itemId} is not in the bank`);
		// Knows everything up to middle: senior questions are answered wrong.
		const option = item.options.find((candidate) => (item.level === 'senior') !== (candidate.id === item.correct));
		if (!option) throw new Error('no option to choose');
		await question.getByLabel(option.text, { exact: true }).check();
		await question.getByRole('button', { name: 'Ответить' }).click();
		answered++;
		await expect(
			page
				.getByTestId('quiz-question')
				.getByRole('heading', { name: `Вопрос ${answered + 1}` })
				.or(result)
		).toBeVisible();
	}
	await expect(page).toHaveURL(/\/me\/tests\/attempts\//);

	// The result: the level with its confidence, where it went, the answers with explanations and the signals.
	await expect(result).toHaveAttribute('data-level', 'middle');
	await expect(result).toHaveAttribute('data-confirmed', 'true');
	await expect(result).toContainText('уверенность в уровне');
	await expect(result).toContainText('В профиль добавлен факт');
	await expect(page.getByTestId('quiz-step')).toHaveCount(answered);
	await expect(page.getByTestId('signals')).toBeVisible();
	await expectNoAxeViolations(page);

	// The page of the attempt speaks of a quiz, not of a practical task in a sandbox.
	await expect(page.getByTestId('honest-note')).toHaveAttribute('data-kind', 'quiz');
	await expect(page.getByTestId('honest-note')).not.toContainText('песочниц');

	// The profile after the recalculation: the fact of the platform test counts toward Python.
	await runQueuedEvidence(hero.candidateId);
	await page.goto('/me/profile');
	const fact = page.getByTestId('fact-card').filter({ hasText: 'Тест платформы' });
	await expect(fact).toHaveCount(1);
	await expect(fact).toContainText('твоя попытка теста на платформе');
	await expect(fact).toContainText('Python');
	await expect(page.getByTestId('skill-list')).toContainText('Python');

	// The catalog shows the best result; the attempt counts toward the limit.
	await page.goto('/me/tests');
	const card = page.getByTestId('assessment-card').filter({ hasText: 'Python: язык и модель выполнения' });
	await expect(card.getByTestId('best-result')).toContainText('Middle');
	await expect(card.getByTestId('attempts-line')).toContainText('Попыток: 1 из');
});

test('a candidate submits a practical task and sees it waiting for the sandbox', async ({ page }) => {
	const hero = await seedCandidate();
	await signIn(page, hero.email);
	const task = bank.find((entry) => entry.key === 'py-access-log');
	const reference = task?.references.python3;
	if (!reference) throw new Error('no reference solution');

	await page.goto('/me/tests');
	await page.getByRole('link', { name: 'Сводка журнала доступа' }).click();
	await expect(page.getByTestId('task-statement')).toContainText('slowest');
	await page.getByRole('button', { name: 'Начать попытку' }).click();
	const editor = page.getByTestId('code-editor');
	await expect(editor).toHaveValue(/sys\.stdin/);
	await expectNoAxeViolations(page);
	await editor.fill(reference);
	await page.getByRole('button', { name: 'Отправить на проверку' }).click();

	await page.waitForURL(/\/me\/tests\/attempts\//);
	const attemptId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
	await expect(page.getByTestId('run-state')).toHaveAttribute('data-run', 'queued');
	await expect(page.getByTestId('submission')).toContainText('slowest');
	await expectNoAxeViolations(page);

	// One submission per attempt: the task now says the attempt is being checked.
	await page.getByRole('link', { name: 'К заданию' }).click();
	await expect(page.getByTestId('pending')).toBeVisible();

	// The run of this submission waits in the queue; the worker of the stand takes it.
	const [submission] = await db()
		.select({ id: assessmentArtifacts.id })
		.from(assessmentArtifacts)
		.where(and(eq(assessmentArtifacts.attemptId, attemptId), eq(assessmentArtifacts.kind, 'code_submission')));
	const [queued] = await db()
		.select({ status: jobs.status })
		.from(jobs)
		.where(eq(jobs.dedupKey, `assessment.run:${submission?.id ?? ''}`));
	expect(queued?.status).toBe('queued');
});
