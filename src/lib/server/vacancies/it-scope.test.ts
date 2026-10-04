import { describe, expect, it } from 'vitest';
import { repositoryTaxonomy } from './fixtures/taxonomy';
import { itScopeOf } from './it-scope';
import { normalizePosting, type OriginalTerms } from './normalize';

const taxonomy = await repositoryTaxonomy();

const scope = (title: string, tags: string[]) => {
	const terms: OriginalTerms = {
		salary_text: null,
		salary: { min: null, max: null, currency: null, period: null, tax_base: null },
		grade_raw: null,
		employment_raw: null,
		location: { city: null, remote: null, raw: null },
		skills_raw: tags,
		description: null,
		contacts_removed: false
	};
	return itScopeOf(normalizePosting(title, terms, taxonomy));
};

describe('IT scope of a posting', () => {
	it('keeps a posting whose title names an IT role, with or without skills', () => {
		expect(scope('Сетевой инженер', ['TCP', 'Техническаяподдержка'])).toMatchObject({ it: true, basis: 'role' });
		expect(scope('Senior DevOps-инженер', ['Docker', 'Kubernetes'])).toMatchObject({ it: true, basis: 'role' });
	});

	it('keeps a posting without a recognized role when it names an IT skill', () => {
		expect(scope('Младший инженер ЦОД', ['DHCP', 'АдминистрированиеоборудованияCisco'])).toEqual({
			it: true,
			basis: 'skills',
			itSkills: ['networking']
		});
		expect(scope('Аналитик-разработчик', ['SQL', 'Python'])).toMatchObject({ it: true, basis: 'skills' });
	});

	it('drops marketing, sales and editorial postings: skills every industry asks for are not IT', () => {
		expect(scope('SMM маркетолог', ['SMM', 'Генерацияидей'])).toMatchObject({ it: false });
		expect(scope('Младший growth-маркетолог', ['Работавкоманде', 'Информационныетехнологии'])).toMatchObject({
			it: false
		});
		expect(scope('Менеджер по активным продажам', ['Управлениепроектами', 'Ведениепереговоров'])).toMatchObject({
			it: false
		});
		expect(scope('Портфельный менеджер', ['MicrosoftExcel', 'Английскийязык'])).toMatchObject({ it: false });
		expect(scope('Сервисный инженер', ['Техническаяподдержка', 'РемонтиобслуживаниеПК'])).toMatchObject({ it: false });
	});

	it('asks an IT skill to confirm a product or project manager: other industries use the same titles', () => {
		expect(scope('Senior Product Manager OTC & Rx', ['Работавкоманде', 'Информационныетехнологии'])).toMatchObject({
			it: false
		});
		expect(scope('Product manager', ['Oracle', '1С'])).toMatchObject({ it: true, basis: 'skills' });
		expect(scope('Project Manager', ['Управлениепроектами', 'Scrum', 'Kanban'])).toMatchObject({
			it: true,
			basis: 'skills',
			itSkills: ['agile']
		});
	});

	it('asks an IT skill to confirm a delivery manager or a presale engineer', () => {
		expect(scope('Delivery Manager', ['Логистика', 'Управлениеперсоналом'])).toMatchObject({ it: false });
		expect(scope('Пресейл-инженер', ['Продажи', 'Ведениепереговоров'])).toMatchObject({ it: false });
		expect(scope('Delivery Manager', ['Jira', 'CI/CD'])).toMatchObject({ it: true, basis: 'skills' });
		expect(scope('Presale engineer', ['Pre-sale', 'Kubernetes'])).toMatchObject({ it: true, basis: 'skills' });
	});
});
