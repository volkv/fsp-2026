import { describe, expect, it } from 'vitest';
import { projectCandidate, type CandidateCardSource } from './projections';

function source(overrides: Partial<CandidateCardSource> = {}): CandidateCardSource {
	return {
		candidateId: 'c-1',
		fullName: { last: 'Иванова', first: 'Мария', middle: null },
		email: 'maria@example.org',
		phone: '+79990000000',
		birthDate: '1999-03-01',
		isMinor: false,
		city: 'Казань',
		region: 'RU-TA',
		regionName: 'Республика Татарстан',
		preferences: {
			workFormats: ['remote'],
			employmentForms: ['full_time'],
			relocation: false,
			searchStatus: 'active',
			salaryExpectation: null
		},
		categories: [],
		categoryMissing: { grade: ['no_dated_experience'] },
		desiredRoleKeys: ['backend'],
		fspLevels: [{ discipline: 'algorithmic', level: 'L4', lastResultOn: '2026-04-20' }],
		skills: [{ skillKey: 'algorithms', strengthBand: 'strong', attestation: 'direct', badgeTrust: 'fsp_verified' }],
		fspAchievements: [
			{
				factId: 'f-1',
				generalized: {
					discipline: 'algorithmic',
					competitionLevel: 'russian_championship',
					season: 2026,
					resultGroup: 'prize',
					format: 'onsite',
					computedIndicator: 'KMS'
				},
				exact: {
					competitionRef: 'comp-1',
					competitionTitle: 'Чемпионат России',
					stage: 'final',
					place: 2,
					team: { name: 'Команда', role: 'captain' },
					protocolUrl: 'https://example.org/protocol'
				}
			},
			{
				factId: 'f-2',
				generalized: {
					discipline: 'product',
					competitionLevel: 'all_russian_ekp',
					season: 2025,
					resultGroup: 'finalist',
					format: 'online',
					computedIndicator: null
				},
				exact: {
					competitionRef: 'comp-2',
					competitionTitle: 'Кубок',
					stage: 'final',
					place: 7,
					team: null,
					protocolUrl: null
				}
			}
		],
		receipts: [
			{ factId: 'f-1', level: 'generalized', handle: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' },
			{ factId: 'f-1', level: 'exact', handle: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' }
		],
		experience: [
			{
				roleKey: 'backend',
				positionTitle: 'Разработчик',
				organizationName: 'ООО «Ромашка»',
				periodFrom: '2021-01-01',
				periodTo: null,
				isCurrent: true,
				duration: { minMonths: 60, maxMonths: 60 },
				appliedSkillKeys: ['go']
			}
		],
		experienceSummary: {
			total: { minMonths: 60, maxMonths: 60 },
			byRole: { backend: { minMonths: 60, maxMonths: 60 } }
		},
		education: [{ level: 'bachelor', field: 'computer_science', institution: 'КФУ', graduationYear: 2021 }],
		assessments: [
			{
				title: 'Go',
				version: 2,
				scoredOn: '2026-09-01',
				level: 'middle',
				skillKeys: ['go'],
				coverage: {},
				attempts: [{ code: 'package main' }]
			}
		],
		externalProfiles: [
			{ platform: 'github', handle: 'maria', verified: true },
			{ platform: 'codeforces', handle: 'maria_cf', verified: false }
		],
		resumeFileId: 'file-1',
		disclosures: [],
		...overrides
	};
}

const PII = [
	'Иванова',
	'maria@example.org',
	'+79990000000',
	'1999-03-01',
	'Ромашка',
	'КФУ',
	'Чемпионат России',
	'file-1',
	'package main'
];

describe('catalog projection', () => {
	it('is pseudonymous: no name, contacts, birth date, employers, institutions or exact results', () => {
		const card = projectCandidate(source(), { projection: 'catalog', extras: [] }, { pseudonym: 'pseudo' });
		const serialized = JSON.stringify(card);
		for (const value of PII) expect(serialized).not.toContain(value);
		expect(card.candidateId).toBeUndefined();
		expect(card.pseudonym).toBe('pseudo');
		expect(card.region).toBe('RU-TA');
		expect(card.city).toBeUndefined();
		expect(card.receipts).toEqual([{ level: 'generalized', handle: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
		expect(card.fspAchievements?.map((achievement) => achievement.receiptHandles)).toEqual([
			['aaaaaaaaaaaaaaaaaaaaaaaaaa'],
			[]
		]);
		expect(card.externalProfiles).toEqual([]);
		expect(card.experience).toEqual([
			{ roleKey: 'backend', duration: { minMonths: 60, maxMonths: 60 }, appliedSkillKeys: ['go'] }
		]);
	});

	it('shows exact achievements and verified profiles only when the adult chose them', () => {
		const card = projectCandidate(
			source(),
			{ projection: 'catalog', extras: ['fsp_achievements_exact', 'external_profiles'] },
			{ pseudonym: 'pseudo' }
		);
		expect(JSON.stringify(card)).toContain('Чемпионат России');
		// One receipt per achievement, at the level it is shown: the generalized one issued earlier stays out.
		expect(card.receipts).toEqual([{ level: 'exact', handle: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' }]);
		expect(card.fspAchievements?.map((achievement) => achievement.receiptHandles)).toEqual([
			['bbbbbbbbbbbbbbbbbbbbbbbbbb'],
			[]
		]);
		expect(card.externalProfiles).toEqual([{ platform: 'github', handle: 'maria', verified: true }]);
	});

	it('shows a teenager only discipline and competition level, whatever the extras say', () => {
		const card = projectCandidate(
			source({ isMinor: true }),
			{ projection: 'catalog', extras: ['fsp_achievements_exact', 'external_profiles'] },
			{ pseudonym: 'pseudo' }
		);
		expect(card.isMinor).toBe(true);
		expect(card.fspAchievements).toEqual([
			{
				generalized: { discipline: 'algorithmic', competitionLevel: 'russian_championship' },
				receiptHandles: ['aaaaaaaaaaaaaaaaaaaaaaaaaa']
			},
			{ generalized: { discipline: 'product', competitionLevel: 'all_russian_ekp' }, receiptHandles: [] }
		]);
		expect(card.externalProfiles).toEqual([]);
		expect(card.receipts?.every((receipt) => receipt.level === 'generalized')).toBe(true);
	});

	it('in a partner pool shows exactly the result of that competition only', () => {
		const card = projectCandidate(
			source(),
			{ projection: 'catalog', extras: ['partner_competition_result'] },
			{ pseudonym: 'pseudo', partnerCompetitionRef: 'comp-2' }
		);
		const serialized = JSON.stringify(card);
		expect(serialized).toContain('Кубок');
		expect(serialized).not.toContain('Чемпионат России');
	});
});

describe('recipient projection', () => {
	it('shows only the contact fields the candidate disclosed', () => {
		const card = projectCandidate(
			source(),
			{ projection: 'recipient', extras: [] },
			{ pseudonym: 'pseudo', disclosedFields: ['full_name', 'email'] }
		);
		expect(card.fullName).toEqual({ last: 'Иванова', first: 'Мария', middle: null });
		expect(card.email).toBe('maria@example.org');
		expect(card.phone).toBeUndefined();
		expect(card.resumeFileId).toBeUndefined();
		expect(card.birthDate).toBeUndefined();
		expect(JSON.stringify(card)).not.toContain('package main');
	});
});

describe('fact ids', () => {
	it('never leave a card of any projection: achievements refer to their receipts by handle', () => {
		const contexts = {
			self: {},
			catalog: { pseudonym: 'pseudo' },
			recipient: { pseudonym: 'pseudo', disclosedFields: ['full_name' as const] },
			public: { publicFields: ['fsp_achievements' as const] },
			operator: {}
		};
		for (const [projection, context] of Object.entries(contexts)) {
			const card = projectCandidate(
				source(),
				{ projection: projection as keyof typeof contexts, extras: ['fsp_achievements_exact'] },
				context
			);
			const serialized = JSON.stringify(card);
			expect(serialized, projection).not.toContain('f-1');
			expect(serialized, projection).not.toContain('f-2');
			expect(serialized, projection).not.toContain('factId');
		}
	});
});

describe('self and operator projections', () => {
	it('shows the candidate everything including what is missing', () => {
		const card = projectCandidate(source(), { projection: 'self', extras: [] });
		expect(card.birthDate).toBe('1999-03-01');
		expect(card.categoryMissing).toEqual({ grade: ['no_dated_experience'] });
	});

	it('shows the operator contacts and the birth date only when the case needs them', () => {
		const plain = projectCandidate(source(), { projection: 'operator', extras: [] });
		expect(plain.email).toBeUndefined();
		expect(plain.birthDate).toBeUndefined();
		const ageCase = projectCandidate(
			source(),
			{ projection: 'operator', extras: [] },
			{ operatorNeeds: new Set(['birth_date']) }
		);
		expect(ageCase.birthDate).toBe('1999-03-01');
	});

	it('refuses to build a company card without a pseudonym', () => {
		expect(() => projectCandidate(source(), { projection: 'catalog', extras: [] })).toThrow(/pseudonym/);
	});
});
