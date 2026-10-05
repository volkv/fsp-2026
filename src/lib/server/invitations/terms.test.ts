import { describe, expect, it, vi } from 'vitest';
import type { TermsContent } from './terms';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { termsChanges } = await import('./terms');

const base: TermsContent = {
	title: 'Go-разработчик',
	description: 'Развиваем платёжный шлюз: Go, PostgreSQL, Kafka. Команда из шести инженеров.',
	vacancy: null,
	category: null,
	salary: { min: 300_000, max: 340_000, currency: 'RUB', period: 'month', taxBase: 'gross' },
	workFormat: 'remote',
	contactMethod: { kind: 'email', value: 'hr@example.ru', note: null },
	whyYou: [{ text: 'Go в профиле', source: { kind: 'declared_skill', ref: 'go' } }],
	message: null
};

describe('termsChanges', () => {
	it('names the changed fields of an offer without a vacancy and marks a lower range', () => {
		const changes = termsChanges({ ...base, salary: { ...base.salary, min: 280_000 }, workFormat: 'hybrid' }, [
			{ version: 1, ...base }
		]);
		expect(changes.fields.map((f) => f.field)).toEqual(['salary_min', 'work_format']);
		expect(changes).toMatchObject({ previous_version: 1, salary_lowered: true, lowered_against_versions: [1] });
	});

	it('does not compare ranges of different tax bases, and shows a vacancy added to the offer', () => {
		const changes = termsChanges(
			{
				...base,
				salary: { ...base.salary, min: 200_000, max: 250_000, taxBase: 'net' },
				vacancy: {
					id: 'v-1',
					snapshot: {
						title: 'Go-разработчик',
						role_key: 'backend',
						grade_min: 'middle',
						grade_max: 'senior',
						work_format: 'remote',
						employment_form: 'full',
						contract_types: ['labor'],
						city_id: null,
						timezone_overlap_hours: null,
						required_skill_keys: ['go'],
						nice_skill_keys: [],
						min_age: null,
						revision: 3
					}
				}
			},
			[{ version: 1, ...base }]
		);
		expect(changes).toMatchObject({ salary_comparison: 'not_comparable', salary_lowered: false });
		expect(changes.fields.map((f) => f.field)).toEqual(
			expect.arrayContaining(['vacancy_id', 'vacancy.title', 'salary_tax_base'])
		);
	});

	it('takes the category for a fact about the candidate, not a changed term', () => {
		const changes = termsChanges({ ...base, category: { specialization: 'backend', grade: 'middle' } }, [
			{ version: 1, ...base }
		]);
		expect(changes.fields).toEqual([]);
	});
});
