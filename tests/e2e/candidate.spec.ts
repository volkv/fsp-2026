// The candidate cabinet in the browser against the local infrastructure (`make infra`, migrated database with the
// published taxonomy, legal documents from `scripts/seed-legal.ts`). The profile is seeded through the services the
// import and the worker use — FSP facts with their claims and receipts, the evidence job, an invitation of a
// verified company — and the candidate then works in the interface.
import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, desc, eq, lte } from 'drizzle-orm';
import { evidenceCompute } from '$lib/server/evidence/job';
import { loadAccessSubject } from '$lib/server/companies/subject';
import type { Database } from '$lib/server/db';
import {
	candidates,
	claims,
	consentEvents,
	jobs,
	legalDocuments,
	passwordCredentials,
	sourceFacts,
	users
} from '$lib/server/db/schema';
import {
	factClaims,
	loadProjectionTaxonomy,
	receiptEligible,
	snapshotFacts,
	snapshotSha256
} from '$lib/server/fsp/projection';
import { createReceiptSigner, issueSelfReceipt } from '$lib/server/fsp/receipts';
import type { AchievementsSnapshot } from '$lib/server/fsp/types';
import { hashPassword } from '$lib/server/auth/password';
import { createLogger } from '$lib/server/jobs/log';
import { completeJob, enqueueJob, type ClaimedJob } from '$lib/server/jobs/queue';
import { decideIn } from '../helpers/categories';
import { createCompany, createMember, createOwnVacancy, offerTerms } from '../helpers/factories';

// `$env/dynamic/private`, which these modules need through `$lib/server/config`, only SvelteKit provides; the hook
// that resolves it for a plain Node test process is registered process-wide, ahead of every worker's first import
// (`playwright.config.ts`, `tests/e2e/helpers/register-server-env.js`).
const { config } = await import('$lib/server/config');
const { fieldCrypto } = await import('$lib/server/crypto/fields');
const { closeDb, db } = await import('$lib/server/db');
const { invitationDeps } = await import('$lib/server/invitations/deps');
const { createInvitation } = await import('$lib/server/invitations/send');

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

async function currentDocumentId(database: Database, kind: 'pd_processing' | 'fsp_import'): Promise<string> {
	const [document] = await database
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(and(eq(legalDocuments.kind, kind), lte(legalDocuments.publishedAt, new Date())))
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!document) throw new Error(`no published ${kind} document: run scripts/seed-legal.ts`);
	return document.id;
}

/** An active candidate with a password, a verified address and the processing consent signed an hour ago. */
async function seedCandidate(input: { birthDate: string; name: string }) {
	const database = db();
	const crypto = fieldCrypto();
	const email = `e2e-candidate-${randomUUID()}@example.org`;
	const now = new Date();
	const [user] = await database
		.insert(users)
		.values({
			status: 'active',
			emailEnc: crypto.encrypt(email, 'users.email'),
			emailHmac: crypto.lookupHmac('email', email),
			emailVerifiedAt: now,
			displayName: input.name
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
			phoneEnc: crypto.encrypt('+7 900 000-00-00', 'candidates.phone'),
			birthDate: input.birthDate,
			birthDatePrecision: 'day',
			birthDateSource: 'self_declared',
			birthDateStatus: 'unverified'
		})
		.returning();
	if (!candidate) throw new Error('candidate not inserted');
	await database.insert(consentEvents).values({
		subjectCandidateId: candidate.id,
		kind: 'pd_processing',
		documentId: await currentDocumentId(database, 'pd_processing'),
		action: 'grant',
		signerKind: 'subject',
		signerUserId: user.id,
		method: 'separate_screen_button',
		evidence: { source: 'e2e' },
		occurredAt: new Date(now.getTime() - 3_600_000)
	});
	return { email, userId: user.id, candidateId: candidate.id };
}

/**
 * An official individual result of the Russian Cup final, stored the way `fsp.sync` stores an import: the fact under
 * the import consent, its claims by the projection rules of the published taxonomy and the candidate's own receipt.
 */
async function seedFspResult(candidateId: string, userId: string): Promise<void> {
	const database = db();
	const taxonomy = await loadProjectionTaxonomy(database);
	if (!taxonomy) throw new Error('no published taxonomy: run `make db-seed-taxonomy`');
	const settings = config();
	const seed = settings.crypto.receiptSigningKeys.get(settings.crypto.activeReceiptSigningKeyId);
	if (!seed) throw new Error('the active receipt signing key is missing');
	const signer = createReceiptSigner({
		issuer: settings.appOrigin,
		keyId: settings.crypto.activeReceiptSigningKeyId,
		seed
	});
	const id = randomUUID();
	const snapshot: AchievementsSnapshot = {
		athlete: { fspId: `e2e-${id}`, lastName: 'Тестова', firstName: 'Анна', birthYear: 1999 },
		qualifications: [],
		results: [
			{
				id: `e2e-result-${id}`,
				competitionId: `e2e-cup-${id}`,
				place: 3,
				placeOf: 120,
				award: 'prize',
				status: 'official'
			}
		],
		competitions: [
			{
				id: `e2e-cup-${id}`,
				ekpNumber: null,
				title: 'Кубок России по спортивному программированию, финал',
				discipline: 'algorithmic',
				level: 'russian_cup',
				stage: 'final',
				ageGroup: 'adults',
				format: 'individual',
				startDate: '2025-11-20',
				online: false
			}
		],
		generatedAt: new Date().toISOString(),
		completeness: { complete: true, sourceVersion: 'e2e', pages: { fetched: 1, total: 1 } }
	};
	const snapshotHash = snapshotSha256(snapshot);
	await database.transaction(async (tx) => {
		const [consent] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'fsp_import',
				documentId: await currentDocumentId(tx, 'fsp_import'),
				action: 'grant',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: { source: 'e2e' },
				occurredAt: new Date()
			})
			.returning({ id: consentEvents.id });
		if (!consent) throw new Error('consent not inserted');
		const now = new Date();
		for (const fact of snapshotFacts(snapshot)) {
			const [row] = await tx
				.insert(sourceFacts)
				.values({
					candidateId,
					source: 'fsp',
					factType: fact.factType,
					sourceRecordRef: fact.sourceRecordRef,
					eventKey: fact.eventKey,
					trustLevel: 'fsp_verified',
					ownershipBasis: 'athlete_link',
					consentEventId: consent.id,
					payload: fact.payload,
					payloadSha256: fact.payloadSha256,
					sourceSnapshotSha256: snapshotHash,
					sourceVersion: 'e2e',
					observedAt: now,
					lastVerifiedAt: now,
					occurredOn: fact.occurredOn,
					status: fact.status
				})
				.returning({ id: sourceFacts.id });
			if (!row) throw new Error('fact not inserted');
			const drafted = factClaims(fact, snapshot.athlete.birthYear, taxonomy);
			if (drafted.length > 0) {
				await tx.insert(claims).values(
					drafted.map((claim) => ({
						candidateId,
						factId: row.id,
						claimType: claim.claimType,
						rawText: claim.rawText,
						polarity: 'asserted' as const,
						skillKey: claim.skillKey,
						value: claim.value,
						extractor: 'source_mapping' as const,
						status: 'active' as const
					}))
				);
			}
			const template = taxonomy.receiptTemplates.get(fact.factType);
			if (template && receiptEligible(fact)) {
				await issueSelfReceipt(tx, signer, template, {
					id: row.id,
					fact,
					sourceRecordRef: fact.sourceRecordRef,
					payloadSha256: fact.payloadSha256,
					sourceSnapshotSha256: snapshotHash,
					lastVerifiedAt: now
				});
			}
		}
		await tx.update(candidates).set({ profileRevision: 1 }).where(eq(candidates.id, candidateId));
	});
}

/** Runs the evidence computation of the candidate the way the worker does: its own job, captured and completed. */
async function computeEvidence(candidateId: string): Promise<void> {
	const database = db();
	const { jobId } = await database.transaction((tx) =>
		enqueueJob(
			tx,
			'evidence.compute',
			{ candidate_id: candidateId },
			{
				inputVersion: '1',
				createdBy: { kind: 'system' }
			}
		)
	);
	const [captured] = await database
		.update(jobs)
		.set({ status: 'running', leaseOwner: 'e2e', leaseExpiresAt: new Date(Date.now() + 120_000), attempts: 1 })
		.where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
		.returning();
	if (!captured) throw new Error(`evidence job ${jobId} was captured by someone else`);
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

/** A verified company invites the candidate to its published vacancy through the invitation service. */
async function seedInvitation(candidateId: string): Promise<string> {
	const database = db();
	const taxonomy = await loadProjectionTaxonomy(database);
	if (!taxonomy) throw new Error('no published taxonomy');
	const company = await createCompany(database, { displayName: `Е2Е Софт ${randomUUID().slice(0, 6)}` });
	const member = await createMember(database, company.id);
	if (member.userId === null) throw new Error('an active member has a user');
	const vacancy = await createOwnVacancy(
		database,
		{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.versionId },
		{ employmentForm: 'full' }
	);
	const subject = await loadAccessSubject(database, {
		kind: 'session',
		userId: member.userId,
		sessionHash: 'e2e',
		authTime: new Date(),
		authMethod: 'password',
		csrfToken: 'e2e'
	});
	const sent = await createInvitation(
		invitationDeps(),
		subject,
		{ requestId: `e2e-${randomUUID()}` },
		{
			...offerTerms({
				vacancyId: vacancy.id,
				salaryMin: 260_000,
				salaryMax: 340_000,
				message: 'Нам понравился ваш результат на Кубке — давайте познакомимся.'
			}),
			candidateId
		}
	);
	return sent.invitationId;
}

/** Open vacancies of a verified company in the role, each requiring SQL and algorithms. */
async function seedRoleVacancies(roleKey: string, count: number): Promise<void> {
	const database = db();
	const taxonomy = await loadProjectionTaxonomy(database);
	if (!taxonomy) throw new Error('no published taxonomy');
	const company = await createCompany(database, { displayName: `Е2Е Рынок ${randomUUID().slice(0, 6)}` });
	const member = await createMember(database, company.id);
	for (let i = 0; i < count; i++) {
		await createOwnVacancy(
			database,
			{ companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.versionId },
			{ roleKey, requiredSkillKeys: ['sql', 'algorithms'], employmentForm: 'full' }
		);
	}
}

async function signIn(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Почта').fill(email);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByRole('button', { name: 'Войти', exact: true }).click();
	await page.waitForURL((url) => url.pathname !== '/login');
}

function yearsAgo(years: number): string {
	const date = new Date();
	date.setUTCFullYear(date.getUTCFullYear() - years);
	date.setUTCDate(date.getUTCDate() - 30);
	return date.toISOString().slice(0, 10);
}

test('a candidate sees the achievement with its receipt, a category without a grade, and accepts an invitation', async ({
	page
}) => {
	const hero = await seedCandidate({ birthDate: yearsAgo(26), name: 'Анна Тестова' });
	await seedFspResult(hero.candidateId, hero.userId);
	await computeEvidence(hero.candidateId);
	await signIn(page, hero.email);

	// Profile: the achievement, its receipt and the skills it counts toward.
	await page.goto('/me');
	await expect(page).toHaveURL(/\/me\/profile$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ваш профиль');
	const achievements = page.getByTestId('fsp-achievements');
	await expect(achievements.getByTestId('fact-card')).toHaveCount(1);
	await expect(achievements.getByText('AC · ФСП').first()).toBeVisible();
	await achievements.getByText('Квитанция проверки: что подтверждено и чего нет').click();
	const receipt = achievements.getByTestId('fact-receipt');
	await expect(receipt.getByText('Действительна')).toBeVisible();
	await expect(receipt.getByText('Уровень соревнования: Кубок России')).toBeVisible();
	await expect(receipt.getByText('коммерческий опыт')).toBeVisible();
	await expect(page.getByTestId('skill-list')).toBeVisible();
	await expectNoAxeViolations(page);

	// Category: without a survey, a declaration and a test there is none — the step to it starts with the survey.
	await page.goto('/me/category');
	await expect(page.getByTestId('next-step')).toHaveAttribute('data-next', 'survey');
	await expect(page.locator('[data-step="test"]')).toHaveAttribute('data-done', 'false');
	await expect(page.getByRole('link', { name: 'Пройти опрос' })).toHaveAttribute('href', '/onboarding/survey');
	// Only a test on the grade gives a category — the FSP result and the resume do not.
	await expect(page.getByTestId('categories').locator('[data-category-state="not_confirmed"]')).toBeVisible();
	await expect(page.locator('[data-notice="recommendation"]')).toBeVisible();
	await expectNoAxeViolations(page);

	// Visibility: an adult shows the profile in the catalog and may add the exact achievements.
	await page.goto('/me/visibility');
	await expect(page.getByTestId('visibility-state')).toHaveAttribute('data-visible', 'false');
	await page.getByRole('checkbox', { name: /Точные достижения ФСП/ }).check();
	await page.getByRole('button', { name: 'Даю согласие и показываю профиль' }).click();
	await expect(page.getByTestId('visibility-state')).toHaveAttribute('data-visible', 'true');
	await expectNoAxeViolations(page);

	// A verified company invites the visible candidate; the notification leads to the invitation.
	const invitationId = await seedInvitation(hero.candidateId);
	await page.goto('/notifications');
	// What the channels carry, as the letter templates write it: the letter names the company, Telegram does not.
	await expect(page.getByText(/^В Telegram — только вид события/)).toContainText(
		'Письмо называет компанию и вакансию, о которых оно'
	);
	await page
		.getByTestId('notification-list')
		.getByRole('link', { name: /Новое приглашение/ })
		.click();
	await expect(page).toHaveURL(new RegExp(`/me/invitations/${invitationId}$`));
	await expect(page.getByTestId('invitation-terms')).toContainText('₽');
	await expectNoAxeViolations(page);

	// Accept with the phone added to the required name and email.
	const answer = page.getByTestId('invitation-answer');
	await answer.getByRole('checkbox', { name: /Телефон/ }).check();
	await answer.getByRole('button', { name: 'Принять и раскрыть выбранное' }).click();
	await expect(page.getByText(/^Приглашение принято: компания получила выбранные контакты/)).toBeVisible();
	await expect(page.getByTestId('disclosure')).toContainText('ФИО, Почта, Телефон');
	await expect(page.getByTestId('hiring-panel')).toBeVisible();

	await page.goto('/me/invitations');
	await expect(page.getByTestId('invitation-list').locator('a[data-invitation-status="accepted"]')).toHaveCount(1);
});

test('a candidate states the search terms, sees vacancies with the match and what the category asks for', async ({
	page
}) => {
	const candidate = await seedCandidate({ birthDate: yearsAgo(30), name: 'Дмитрий Тестов' });
	await seedFspResult(candidate.candidateId, candidate.userId);
	await computeEvidence(candidate.candidateId);
	await signIn(page, candidate.email);

	await page.goto('/me/settings');
	await page.getByLabel('Роль 1').selectOption({ label: 'Бэкенд-разработчик' });
	await page.getByLabel('От', { exact: true }).fill('250000');
	await page.getByRole('checkbox', { name: 'Удалённо' }).check();
	// The region is picked from the reference: the search narrows the list, the chosen region is kept.
	const region = page.getByRole('combobox', { name: 'Регион', exact: true });
	await expect(region).toHaveValue('');
	await page.getByLabel('Найти регион').fill('татар');
	await expect(page.getByTestId('region-picker')).toContainText('Найдено: 1');
	await expect(region.locator('option')).toHaveText(['не указан', 'Республика Татарстан']);
	await region.selectOption({ label: 'Республика Татарстан' });
	await page.getByRole('button', { name: 'Сохранить' }).click();
	await expect(page.getByText('Сохранено. Соответствие вакансиям пересчитывается.')).toBeVisible();
	await expect(page.getByLabel('От', { exact: true })).toHaveValue('250000');
	await expect(region).toHaveValue('RU-TA');
	await page.reload();
	await expect(page.getByRole('combobox', { name: 'Регион', exact: true })).toHaveValue('RU-TA');
	await expect(page.getByRole('combobox', { name: 'Регион', exact: true }).locator('option:checked')).toHaveText(
		'Республика Татарстан'
	);
	await expectNoAxeViolations(page);

	await page.goto('/me/profile');
	// Open to offers shows the profile: without the catalog consent the choice asks for it once and saves both.
	await page.getByRole('radio', { name: /Открыт к предложениям/ }).check();
	const consent = page.getByRole('dialog', { name: 'Показать профиль работодателям' });
	await consent.getByRole('button', { name: 'Согласен, показать профиль' }).click();
	await expect(page.getByText('Статус поиска сохранён.')).toBeVisible();
	await expect(page.getByTestId('search-status')).toHaveAttribute('data-status', 'open_to_offers');
	await expect(page.getByTestId('search-status')).toHaveAttribute('data-consented', 'true');
	// «Не ищу» keeps the consent: it is withdrawn only on the page of consents.
	await page.getByRole('radio', { name: /Не ищу/ }).check();
	await expect(page.getByTestId('search-status')).toHaveAttribute('data-status', 'not_looking');
	await expect(page.getByTestId('search-status')).toHaveAttribute('data-consented', 'true');
	await page.getByRole('radio', { name: /Открыт к предложениям/ }).check();
	await expect(page.getByTestId('search-status')).toHaveAttribute('data-status', 'open_to_offers');
	await expect(consent).toHaveCount(0);
	await expectNoAxeViolations(page);

	await page.goto('/me/vacancies');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вакансии для вас');
	await expect(page.getByTestId('search-status')).toHaveCount(0);
	await expect(page.getByRole('combobox', { name: 'Грейд' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Откликнуться/ })).toHaveCount(0);
	await expectNoAxeViolations(page);

	// The market of the category waits for the category: without a test there is no specialization and grade to count.
	await seedRoleVacancies('backend', 5);
	await page.goto('/me/category');
	await expect(page.getByTestId('market-demand')).toContainText('Категория не подтверждена');
	await expect(page.getByTestId('market-demand').locator('[data-demand-state="available"]')).toHaveCount(0);
	await expect(page.getByTestId('objections')).toContainText('Возражений нет.');
	await expectNoAxeViolations(page);

	await page.goto('/account/notifications');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Настройки уведомлений');
	await expect(page.getByText(/^Уведомления всегда есть в интерфейсе/)).toContainText(
		'письмо называет компанию и вакансию, о которых оно'
	);
	await expectNoAxeViolations(page);
});

test('a candidate under 18 is not offered the exact achievements in the catalog', async ({ page }) => {
	const teen = await seedCandidate({ birthDate: yearsAgo(16), name: 'Подросток Тестов' });
	await signIn(page, teen.email);
	await page.goto('/me/visibility');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Видимость и согласия');
	await expect(page.getByTestId('minor-regime')).toBeVisible();
	await expect(page.getByRole('checkbox', { name: /Точные достижения/ })).toHaveCount(0);
	await expectNoAxeViolations(page);
});

test('a candidate fills the profile, downloads the PDF and its QR leads to a valid confirmation of the category', async ({
	page
}) => {
	const candidate = await seedCandidate({ birthDate: yearsAgo(27), name: 'Мария Иванова' });
	await db().transaction((tx) => decideIn(tx, candidate.candidateId, { specialization: 'backend', grade: 'junior' }));
	await signIn(page, candidate.email);

	await page.goto('/me/profile');
	const fields = page.getByTestId('profile-fields');
	await fields.getByLabel('Фамилия').fill('Иванова');
	await fields.getByLabel('Имя', { exact: true }).fill('Мария');
	// Each change is saved at once: the name when the focus leaves its fields, a contact on blur, a soft skill on click.
	await fields.getByLabel('Telegram').fill('t.me/maria_dev');
	await fields.getByRole('checkbox', { name: 'Работа в команде' }).check();
	await expect(fields.getByLabel('Telegram')).toHaveValue('@maria_dev');
	await expect(
		page.getByTestId('profile-contacts').locator('[data-testid="field-save"][data-state="saved"]')
	).toHaveCount(1);
	await expect(page.getByTestId('profile-soft-skills').getByTestId('save-status')).toHaveAttribute(
		'data-state',
		'saved'
	);
	await page.reload();
	await expect(fields.getByLabel('Фамилия')).toHaveValue('Иванова');
	await expect(fields.getByLabel('Telegram')).toHaveValue('@maria_dev');
	await expect(fields.getByRole('checkbox', { name: 'Работа в команде' })).toBeChecked();
	await expectNoAxeViolations(page);

	// The PDF of the candidate's session, with the address of the confirmation as the link of its QR code.
	const pdf = await page.request.get('/me/profile/pdf?email=on&telegram=on');
	expect(pdf.status()).toBe(200);
	expect(pdf.headers()['content-type']).toBe('application/pdf');
	const body = await pdf.body();
	expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');

	// The confirmation the QR code leads to, with the holder code, as the profile gives it to its owner.
	const own = await page.request.get('/api/v1/me/profile');
	expect(own.status()).toBe(200);
	const { attestations } = (await own.json()) as {
		attestations: { handle: string; status: string; holder_code: string }[];
	};
	const attestation = attestations.find((item) => item.status === 'valid');
	if (!attestation) throw new Error('the PDF issued no valid confirmation');
	const href = `/verify/categories/${attestation.handle}`;

	// Anyone opens the confirmation: the category in force, no name; the holder proves it with the name and the code.
	const visitor = await page.context().browser()?.newPage();
	if (!visitor) throw new Error('no browser');
	await visitor.goto(`${APP_ORIGIN}${href}`);
	await expect(visitor.getByTestId('attestation-status')).toHaveAttribute('data-status', 'valid');
	await expect(visitor.getByTestId('attestation-signature')).toHaveAttribute('data-signature', 'valid');
	await expect(visitor.locator('body')).not.toContainText('Иванова');
	await visitor.getByLabel('ФИО').fill('Иванова Мария');
	await visitor.getByLabel('Код владельца').fill(attestation.holder_code);
	await visitor.getByRole('button', { name: 'Проверить' }).click();
	await expect(visitor.getByText('Совпадает: подтверждение выдано человеку с этим ФИО.')).toBeVisible();
	await visitor.close();
});
