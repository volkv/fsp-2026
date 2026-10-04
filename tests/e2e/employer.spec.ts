// The employer cabinet in the browser against the local infrastructure (`make infra`) with the models switched off:
// an employer registers, the operator's decision makes the company verified, a candidate visible in the catalog is
// seeded in the database the way the categorization job stores it, and the employer goes from pasted vacancy text (the
// rules mode without the model) to the candidates for the vacancy, the catalog card and the invitation. An
// unverified company cannot publish. The main screens have no accessibility violations.
//
// Employers register through the form: their password, address and session need the field keys of the application,
// which only the running application holds. Everything else is written directly, since it is state the product
// receives from other parts (the operator's decision, the categorization run, the published policies).
import { randomBytes, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test';
import { APP_ORIGIN } from './helpers/ports';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
	auditEvents,
	candidates,
	categorizationRulesets,
	categorizationRuns,
	categoryAssignments,
	companies,
	consentEvents,
	fspLevelAssignments,
	legalDocuments,
	skillInferences,
	sourceFacts,
	taxonomyVersions,
	users
} from '$lib/server/db/schema';

const PASSWORD = 'e2e passphrase long';

// The pool of the application's own module: `closeDb` in `afterAll` ends it and the next query opens a new one, so a
// worker that comes back to this file for another group of its tests (fullyParallel) still reaches the database.
const { closeDb, db } = await import('$lib/server/db');
const { fieldCrypto } = await import('$lib/server/crypto/fields');

test.afterAll(async () => {
	await closeDb();
});

async function expectNoAxeViolations(page: Page): Promise<void> {
	const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
	expect(result.violations.map((v) => v.id)).toEqual([]);
}

/** A 10-digit taxpayer number of an organization with valid check digits. */
function organizationInn(): string {
	const digits = Array.from({ length: 9 }, (_, index) =>
		index === 0 ? 1 + ((randomBytes(1)[0] ?? 0) % 9) : (randomBytes(1)[0] ?? 0) % 10
	);
	const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
	const sum = digits.reduce((total, digit, index) => total + digit * (weights[index] ?? 0), 0);
	return [...digits, (sum % 11) % 10].join('');
}

/** Registers an employer through the form; the registration creates the company draft with the person as owner. */
async function registerEmployer(page: Page, companyName: string): Promise<{ inn: string }> {
	const inn = organizationInn();
	await page.goto('/register');
	await page.getByRole('radio', { name: /Нанимаю/ }).check();
	await page.getByLabel('Ваше имя').fill('Рекрутер Проверочный');
	await page.getByLabel('Рабочая почта').fill(`e2e-employer-${randomUUID()}@example.org`);
	await page.getByLabel('Пароль').fill(PASSWORD);
	await page.getByLabel('Название компании').fill(companyName);
	await page.getByLabel('ИНН компании').fill(inn);
	for (const checkbox of await page.getByRole('checkbox', { name: /Принимаю/ }).all()) await checkbox.check();
	await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
	await expect(page).toHaveURL(/\/onboarding/);
	return { inn };
}

/** The operator's decision: the company becomes verified. Returns its id. */
async function verifyCompany(inn: string): Promise<string> {
	const updated = await db()
		.update(companies)
		.set({ status: 'verified', verifiedAt: new Date() })
		.where(and(eq(companies.inn, inn), eq(companies.status, 'draft')))
		.returning({ id: companies.id });
	expect(updated).toHaveLength(1);
	const [company] = updated;
	if (!company) throw new Error(`company ${inn} not verified`);
	return company.id;
}

async function currentDocument(kind: 'pd_processing' | 'catalog_visibility'): Promise<string> {
	const [row] = await db()
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(
			and(eq(legalDocuments.kind, kind), isNotNull(legalDocuments.publishedAt), isNull(legalDocuments.supersededAt))
		)
		.orderBy(desc(legalDocuments.version))
		.limit(1);
	if (!row) throw new Error(`no published ${kind} document: run scripts/seed-legal.ts`);
	return row.id;
}

const sha256 = () => randomBytes(32).toString('hex');

/**
 * An adult candidate in the catalog with the consents, an FSP result and the published categorization run as the
 * categorization job writes them: backend by confirmed Go, grade not established (FSP does not set a grade). Other
 * candidates of the database may share its region: the test finds this one by its pseudonym for the company.
 * Returns its internal ids, which must never reach a company.
 */
async function seedCandidate(region: string): Promise<{ candidateId: string; factId: string }> {
	const [taxonomy] = await db()
		.select({ id: taxonomyVersions.id, label: taxonomyVersions.label })
		.from(taxonomyVersions)
		.where(eq(taxonomyVersions.status, 'published'))
		.orderBy(desc(taxonomyVersions.publishedAt))
		.limit(1);
	if (!taxonomy) throw new Error('no published taxonomy: run scripts/seed-taxonomy.ts');
	const [ruleset] = await db()
		.select({ id: categorizationRulesets.id, version: categorizationRulesets.version })
		.from(categorizationRulesets)
		.where(eq(categorizationRulesets.taxonomyVersionId, taxonomy.id))
		.orderBy(desc(categorizationRulesets.version))
		.limit(1);
	if (!ruleset) throw new Error('no categorization rule set of the published taxonomy');

	return db().transaction(async (tx) => {
		const [user] = await tx
			.insert(users)
			.values({ status: 'active', emailEnc: randomBytes(40), emailHmac: sha256(), displayName: 'Кандидат e2e' })
			.returning({ id: users.id });
		if (!user) throw new Error('user not inserted');
		const [candidate] = await tx
			.insert(candidates)
			.values({
				userId: user.id,
				status: 'active',
				searchStatus: 'active',
				visibility: 'catalog',
				profileRevision: 1,
				birthDate: '2001-03-15',
				birthDatePrecision: 'day',
				birthDateSource: 'self_declared',
				birthDateStatus: 'unverified',
				desiredRoleKeys: ['backend'],
				preferences: {
					work_formats: ['remote', 'hybrid'],
					region_code: region,
					salary_expectation: { min: 200_000, max: 240_000, currency: 'RUB', period: 'month', tax_base: 'net' }
				},
				seedBatchId: 'e2e-employer'
			})
			.returning({ id: candidates.id });
		if (!candidate) throw new Error('candidate not inserted');
		const consent = { subjectCandidateId: candidate.id, action: 'grant' as const, signerKind: 'subject' as const };
		await tx.insert(consentEvents).values([
			{
				...consent,
				kind: 'pd_processing',
				documentId: await currentDocument('pd_processing'),
				signerUserId: user.id,
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: new Date(Date.now() - 86_400_000)
			},
			{
				...consent,
				kind: 'catalog_visibility',
				documentId: await currentDocument('catalog_visibility'),
				signerUserId: user.id,
				scopeFields: ['fsp_achievements_exact'],
				method: 'separate_screen_button',
				evidence: {},
				occurredAt: new Date(Date.now() - 86_400_000)
			}
		]);
		const [fact] = await tx
			.insert(sourceFacts)
			.values({
				candidateId: candidate.id,
				source: 'fsp',
				factType: 'competition_result',
				sourceRecordRef: `fsp:result:${randomUUID()}`,
				eventKey: 'fsp:competition:e2e-cup-2025',
				sourceSnapshotSha256: sha256(),
				trustLevel: 'fsp_verified',
				ownershipBasis: 'operator_confirmed',
				payload: {
					result: {
						id: randomUUID(),
						competitionId: 'e2e-cup-2025',
						place: 2,
						award: 'prize',
						status: 'official',
						team: { id: randomUUID(), name: 'Северный ветер', role: 'captain', specialization: 'backend' }
					},
					competition: {
						id: 'e2e-cup-2025',
						ekpNumber: null,
						title: 'Кубок России по спортивному программированию, финал',
						discipline: 'product',
						level: 'russian_cup',
						stage: 'final',
						format: 'team',
						startDate: '2025-04-10',
						online: false
					}
				},
				payloadSha256: sha256(),
				observedAt: new Date(),
				lastVerifiedAt: new Date(),
				occurredOn: '2025-04-12',
				status: 'active'
			})
			.returning({ id: sourceFacts.id });
		if (!fact) throw new Error('fact not inserted');
		const [run] = await tx
			.insert(categorizationRuns)
			.values({
				candidateId: candidate.id,
				inputRevision: 1,
				inputSnapshotSha256: sha256(),
				inputRefs: { facts: [fact.id], claims: [] },
				taxonomyVersionId: taxonomy.id,
				rulesetId: ruleset.id,
				asOf: new Date(),
				computedAt: new Date(),
				origin: 'automatic',
				outcome: 'partial',
				missing: { role: [], grade: [{ code: 'no_dated_experience' }], stack: [] },
				experienceSummary: {
					total: { min_months: 0, max_months: 0 },
					by_role: {},
					by_skill: {},
					counted_entry_ids: [],
					excluded: []
				},
				status: 'published'
			})
			.returning({ id: categorizationRuns.id });
		if (!run) throw new Error('run not inserted');
		const inference = (skillKey: string, band: 'weak' | 'moderate' | 'strong', attestation: 'direct' | 'derived') => ({
			runId: run.id,
			candidateId: candidate.id,
			skillKey,
			strength: band === 'strong' ? '0.850' : band === 'moderate' ? '0.550' : '0.250',
			strengthBand: band,
			attestation,
			badgeTrust: attestation === 'direct' ? ('fsp_verified' as const) : null,
			contributions: [{ fact_id: fact.id, attestation }]
		});
		await tx
			.insert(skillInferences)
			.values([inference('go', 'strong', 'direct'), inference('postgresql', 'moderate', 'derived')]);
		await tx.insert(categoryAssignments).values({
			runId: run.id,
			rank: 'primary',
			roleStatus: 'established',
			roleKey: 'backend',
			score: '0.78',
			gradeStatus: 'insufficient_data',
			stackStatus: 'established',
			stackSkillKeys: ['go'],
			explanation: {
				ruleset_version: ruleset.version,
				taxonomy_version: taxonomy.label,
				role: {
					role_key: 'backend',
					score: 0.78,
					skill_fit: 0.8,
					role_evidence: 0.7,
					core_groups: [],
					unconfirmed_core_groups: [],
					contributions: []
				},
				grade: {
					status: 'insufficient_data',
					scope: 'all_experience',
					signals: [],
					ignored: [{ code: 'fsp_does_not_set_grade', fact_ids: [fact.id] }],
					disagreements: [],
					missing: [{ code: 'no_dated_experience' }],
					next_grade: null
				},
				stack: { status: 'established', skills: [], missing: [] },
				desired_roles: [],
				fsp_markers: []
			}
		});
		await tx.insert(fspLevelAssignments).values({
			runId: run.id,
			discipline: 'product',
			level: 'L4',
			basisFactIds: [fact.id],
			lastResultOn: '2025-04-12'
		});
		return { candidateId: candidate.id, factId: fact.id };
	});
}

/** Fills the vacancy form; the pasted text is already in the description when the draft comes from text. */
async function fillVacancyForm(page: Page, title: string, description?: string): Promise<void> {
	await page.getByLabel('Название вакансии').fill(title);
	await page.getByLabel('Роль').selectOption('backend');
	await page.getByLabel('Грейд от').selectOption('junior');
	await page.getByLabel('Грейд до').selectOption('middle');
	await page.getByLabel('Обязательные навыки').fill('Go, PostgreSQL');
	await page.getByLabel('Желательные навыки').fill('Kubernetes');
	await page.getByLabel('От', { exact: true }).fill('200000');
	await page.getByLabel('До', { exact: true }).fill('230000');
	await page.getByLabel('Валюта').selectOption('RUB');
	await page.getByLabel('Период').selectOption('month');
	await page.getByRole('radio', { name: 'на руки' }).check();
	await page.getByLabel('Формат', { exact: true }).selectOption('hybrid');
	await page.getByLabel('Занятость', { exact: true }).selectOption('full');
	await page.getByRole('checkbox', { name: 'Трудовой договор (ТК РФ)' }).check();
	if (description !== undefined) await page.getByLabel('Описание').fill(description);
}

const VACANCY_TEXT = [
	'Middle Go-разработчик (backend)',
	'Ищем разработчика в команду платёжных сервисов.',
	'Обязательно: Go, PostgreSQL. Желательно: Kubernetes.',
	'Зарплата 200–230 тыс. ₽ на руки, гибрид или удалёнка, полная занятость, оформление по ТК РФ.'
].join('\n');

// Forms are posted to the public origin of the application (playwright.config.ts, APP_ORIGIN).
test.use({ baseURL: APP_ORIGIN });

test('a verified company turns pasted text into a vacancy, finds a candidate and invites them', async ({ page }) => {
	const region = 'RU-MOW';
	const seeded = await seedCandidate(region);
	const { inn } = await registerEmployer(page, 'Северный код e2e');
	const companyId = await verifyCompany(inn);
	const pseudonym = fieldCrypto().pseudonym(seeded.candidateId, companyId);

	await page.goto('/company/vacancies');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Вакансии');
	await expectNoAxeViolations(page);

	// Pasted text without the model: the rules read the fields, the page says so and the employer checks them.
	await page.getByRole('link', { name: 'Новая вакансия' }).click();
	await page.getByLabel('Текст вакансии').fill(VACANCY_TEXT);
	await page.getByRole('button', { name: 'Разобрать' }).click();
	await expect(page.getByTestId('draft')).toHaveAttribute('data-mode', 'rules');
	await expect(page.getByTestId('rules-mode')).toContainText('Разобрано правилами, проверьте поля');
	await expect(page.locator('[data-notice="degraded"]')).toBeVisible();
	await expect(page.getByLabel('Описание')).toHaveValue(VACANCY_TEXT);
	await expect(page.getByTestId('draft-missing')).toContainText('Дозаполните');
	// The rules recognize the role, so the suggested range is placed against the market of its category.
	await expect(page.getByTestId('market-position')).toHaveAttribute('data-state', 'evaluated');
	await expectNoAxeViolations(page);
	await fillVacancyForm(page, 'Middle Go-разработчик');
	// The range as edited, against the market of its category, before anything is saved.
	await page.getByRole('button', { name: 'Пересчитать положение вилки' }).click();
	const market = page.getByTestId('market-position');
	await expect(market).toHaveAttribute('data-state', 'evaluated');
	await expect(market.locator('[data-indicator]')).toHaveCount(2);
	await expect(market.locator('[data-indicator="vacancy_ranges"]')).toHaveAttribute(
		'data-status',
		/^(compared|not_comparable|insufficient_data)$/u
	);
	await expect(page.getByLabel('Обязательные навыки')).toHaveValue('Go, PostgreSQL');
	// The hints of the parse outlive the recalculation: it answers with the form values only.
	await expect(page.getByTestId('draft')).toHaveAttribute('data-mode', 'rules');
	await expect(page.getByTestId('draft-missing')).toContainText('Дозаполните');
	await expectNoAxeViolations(page);
	await page.getByRole('button', { name: 'Сохранить черновик' }).click();

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Middle Go-разработчик');
	await expect(page.getByText('Черновик сохранён')).toBeVisible();
	await page.getByRole('button', { name: 'Опубликовать' }).click();
	await expect(page.getByText('Вакансия опубликована.')).toBeVisible();

	// The candidates for the vacancy in the region of the seeded one.
	await page.getByRole('link', { name: 'Кандидаты под вакансию' }).first().click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Кандидаты под вакансию');
	await expect(page.locator('[data-notice="recommendation"]').first()).toBeVisible();
	// The region is chosen by its name from the reference; the address carries its code.
	const regions = page.getByTestId('region-filter');
	await regions.getByRole('searchbox').fill('моск');
	await expect(regions.getByRole('checkbox', { name: 'Московская область' })).toBeVisible();
	await expect(regions.getByRole('checkbox', { name: 'Санкт-Петербург' })).toBeHidden();
	await regions.getByRole('checkbox', { name: 'Москва', exact: true }).check();
	await expect(regions).toContainText('Выбрано: Москва');
	await expectNoAxeViolations(page);
	await page.getByRole('button', { name: 'Показать' }).click();
	await expect(page).toHaveURL(new RegExp(`region=${region}`));
	await expect(regions.getByRole('checkbox', { name: 'Москва', exact: true })).toBeChecked();
	await expect(page.getByTestId('search-mode')).toHaveAttribute('data-search-mode', 'fts_only');
	const row = page.locator(`[data-candidate="${pseudonym}"]`);
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('Бэкенд');
	await expect(row).toContainText('грейд не установлен');
	await expect(row).toContainText('Уровень ФСП');
	await row.getByText('Разложение соответствия').click();
	await expect(row.getByText('Что подходит и чем подтверждено')).toBeVisible();
	await expectNoAxeViolations(page);

	// The catalog card: pseudonym only, category by axes, confirmed skills, the FSP result, the invitation.
	await row.getByRole('link', { name: 'Открыть карточку' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Кандидат');
	const card = page.getByTestId('candidate-card');
	await expect(card).toBeVisible();
	await expect(card.locator('[data-axis="grade"]')).toHaveAttribute('data-status', 'insufficient_data');
	await expect(card.locator('[data-skill="go"]')).toContainText('ФСП');
	await expect(card).toContainText('Кубок России по спортивному программированию, финал');
	await expect(card).not.toContainText('Кандидат e2e');
	await expect(card).toContainText('Москва');
	// Opening the card issued the company one receipt of the achievement, exact since the candidate disclosed it.
	await expect(card.locator('[data-receipt-status="valid"]')).toHaveCount(1);
	const receipt = card.getByRole('article', { name: /Квитанция проверки/ });
	await expect(receipt).toContainText('Показаны точные сведения.');
	// The stage is named as on the public check page, not by its code.
	await expect(receipt).toContainText('Этап: финал');
	await expectNoAxeViolations(page);
	const cardUrl = page.url();
	// The data of the page as the browser gets it carries no internal id of the candidate or of their facts.
	const pageData = await (await page.request.get(`${new URL(cardUrl).pathname}/__data.json`)).text();
	expect(pageData).toContain('receiptHandles');
	for (const id of [seeded.candidateId, seeded.factId]) expect(pageData).not.toContain(id);
	await card.getByRole('link', { name: 'Проверить подпись' }).first().click();
	await expect(page).toHaveURL(/\/verify\/[a-z2-7]{26}$/u);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Проверка квитанции');
	await expect(page.getByTestId('receipt-signature')).toHaveAttribute('data-signature', 'valid');
	await expect(page.locator('body')).not.toContainText('Кандидат e2e');
	await page.goto(cardUrl);

	const invite = page.getByTestId('invite-form');
	await expect(invite.getByLabel(/^От/)).toHaveValue('200000');
	await invite.getByLabel(/Сообщение/).fill('Здравствуйте! Будем рады обсудить вакансию.');
	await invite.getByRole('button', { name: 'Пригласить' }).click();

	await expect(page).toHaveURL(/\/company\/invitations\/[0-9a-f-]+\?sent=1$/);
	await expect(page.getByText('Приглашение отправлено.')).toBeVisible();
	await expect(page.getByTestId('current-terms')).toContainText('версия 1');
	await expect(page.getByTestId('current-terms')).toContainText('осталось');
	await expectNoAxeViolations(page);

	// A revision is a new version; the first one stays in the history.
	await page.getByLabel(/^До/).fill('240000');
	await page.getByRole('button', { name: 'Отправить новую версию' }).click();
	await expect(page.getByText('Отправлена версия 2.')).toBeVisible();
	await expect(page.locator('[data-version]')).toHaveCount(2);

	await page.goto('/company/invitations');
	await expect(page.locator('[data-invitation]')).toHaveCount(1);
	await page.goto('/company/hiring');
	await expect(page.getByText('Процессов найма пока нет')).toBeVisible();

	// The owner's company pages: profile of a verified company, the team, an API key shown once.
	await page.goto('/company/profile');
	await expect(page.getByTestId('verification-state')).toHaveCount(0);
	await expect(page.getByText('Проверена', { exact: true })).toBeVisible();
	await expectNoAxeViolations(page);
	await page.goto('/company/profile/team');
	await expect(page.locator('[data-member]')).toHaveCount(1);
	await expectNoAxeViolations(page);
	await page.goto('/company/profile/keys');
	await page.getByLabel('Название').fill('Интеграция e2e');
	await page.getByRole('checkbox', { name: 'Поиск по каталогу кандидатов' }).check();
	await page.getByRole('button', { name: 'Создать ключ' }).click();
	await expect(page.getByTestId('api-key-secret')).toContainText(/fspk_[a-z2-7]{8}_/);
	await expectNoAxeViolations(page);
	await page.reload();
	await expect(page.getByTestId('api-key-secret')).toHaveCount(0);

	// A region typed into the address instead of chosen is refused, not searched with nobody to find.
	await page.goto('/company/candidates?region=Москва');
	await expect(page.getByText('Таких регионов нет в справочнике: Москва')).toBeVisible();
	await expect(page.locator('[data-candidate]')).toHaveCount(0);

	await page.goto(`/company/candidates?region=${region}`);
	const listed = page.locator(`[data-candidate="${pseudonym}"]`);
	await expect(listed).toHaveCount(1);
	await listed.getByRole('link', { name: 'Открыть карточку' }).click();
	await expect(page.getByTestId('candidate-card')).toBeVisible();
	await expectNoAxeViolations(page);
});

test('hovering the candidate link does not open the card; clicking it does', async ({ page }) => {
	// Opening the card runs the full catalog search, issues the company's receipts and journals `card.viewed` — a
	// mere hover (a scan of the list, not an intent to open) must not run any of that.
	const region = 'RU-YEV';
	const seeded = await seedCandidate(region);
	const { inn } = await registerEmployer(page, 'Осторожный взгляд e2e');
	const companyId = await verifyCompany(inn);
	const pseudonym = fieldCrypto().pseudonym(seeded.candidateId, companyId);

	await page.goto(`/company/candidates?region=${region}`);
	const row = page.locator(`[data-candidate="${pseudonym}"]`);
	await expect(row).toHaveCount(1);
	const link = row.getByRole('link', { name: 'Открыть карточку' });

	const cardDataRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/company/candidates/') && request.url().includes('__data.json'))
			cardDataRequests.push(request.url());
	});

	const cardViews = () =>
		db()
			.select({ id: auditEvents.id })
			.from(auditEvents)
			.where(and(eq(auditEvents.action, 'card.viewed'), eq(auditEvents.subjectCandidateId, seeded.candidateId)))
			.then((rows) => rows.length);

	await link.hover();
	// SvelteKit's hover preload debounces 20ms after the mouse comes to rest; this is well clear of it.
	await page.waitForTimeout(500);
	expect(cardDataRequests).toHaveLength(0);
	expect(await cardViews()).toBe(0);

	await link.click();
	await expect(page.getByTestId('candidate-card')).toBeVisible();
	expect(cardDataRequests.length).toBeGreaterThan(0);
	expect(await cardViews()).toBe(1);
});

test('an unverified company prepares a vacancy but cannot publish it or open the catalog', async ({ page }) => {
	await registerEmployer(page, 'Компания на проверке e2e');

	await page.goto('/company/vacancies/new');
	await expect(page.getByTestId('company-gate')).toContainText('не подана на проверку');
	await fillVacancyForm(page, 'Стажёр-разработчик на Go', 'Стажировка в команде бэкенда: Go, PostgreSQL, код-ревью.');
	await page.getByRole('button', { name: 'Сохранить черновик' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Стажёр-разработчик на Go');

	await page.getByRole('button', { name: 'Опубликовать' }).click();
	await expect(page.locator('[data-tone="error"]')).toContainText(
		'Публиковать вакансии может только проверенная компания'
	);

	await page.goto('/company/candidates');
	await expect(page.getByText('Каталог кандидатов закрыт до проверки компании')).toBeVisible();
	await expectNoAxeViolations(page);
});
