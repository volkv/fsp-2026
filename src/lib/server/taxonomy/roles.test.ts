import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRelease, readTaxonomyDatasets } from './release';
import { roleOfTitle } from './roles';

const TAXONOMY_DIR = fileURLToPath(new URL('../../../../taxonomy', import.meta.url));
const roles = buildRelease(await readTaxonomyDatasets(TAXONOMY_DIR)).content.roles.map((role) => ({
	key: role.key,
	nameRu: role.name_ru
}));

describe('role of a job title', () => {
	it.each([
		['Backend-разработчик (Go)', 'backend'],
		['Go-разработчик', 'backend'],
		['Senior Python Developer', 'backend'],
		['Frontend developer React', 'frontend'],
		['React Native разработчик', 'mobile'],
		['Fullstack-разработчик', 'fullstack'],
		['Руководитель Frontend-разработки / Head of Frontend', 'team_lead'],
		['Руководитель группы разработки', 'team_lead'],
		['Middle Инженер по автоматизации тестирования', 'qa_automation'],
		['Тестировщик-автоматизатор', 'qa_automation'],
		['QA Automation Engineer', 'qa_automation'],
		['Инженер по тестированию', 'qa_manual'],
		['Тестировщик (Верификатор) / QA Engineer', 'qa_manual'],
		['Data Engineer (команда RecSys)', 'data_engineer'],
		['Аналитик данных', 'data_analyst'],
		['Системный аналитик', 'systems_analyst'],
		['Программист 1С', 'onec'],
		['Android-разработчик', 'mobile'],
		['DevOps-инженер', 'devops'],
		['Инженер техподдержки', 'tech_support'],
		['UI/UX дизайнер', 'ui_ux_designer'],
		['C++ разработчик', 'systems_programmer'],
		['Системный программист', 'systems_programmer'],
		['Инженер-робототехник', 'robotics_engineer'],
		['Разработчик ПО для БПЛА', 'uav_engineer'],
		['Пресейл-инженер', 'presale'],
		['Presale Manager', 'presale'],
		['Pre-sale архитектор', 'presale'],
		['Delivery Manager', 'delivery_manager'],
		['Деливери-менеджер', 'delivery_manager'],
		['Руководитель проектов', 'project_manager'],
		['Специалист SAM', 'sam_specialist'],
		['Software Asset Manager', 'sam_specialist'],
		['Специалист по лицензированию ПО', 'sam_specialist']
	])('%s → %s', (title, role) => {
		expect(roleOfTitle(title, roles)).toBe(role);
	});

	// A title inside a sentence of search is inflected: the job nouns are read in any case and in the plural.
	it.each([
		['Ищем аналитика данных', 'data_analyst'],
		['в команду дата-инженера', 'data_engineer'],
		['на позицию QA-инженера', 'qa_manual'],
		['ведущего системного аналитика', 'systems_analyst'],
		['Приглашаем тестировщика в команду платежей', 'qa_manual'],
		['требуется инженер данных', 'data_engineer'],
		['ищем инженеров по тестированию', 'qa_manual'],
		['ищем руководителя проектов', 'project_manager'],
		['в поиске технического писателя', 'tech_writer'],
		['на роль технического директора', 'cto'],
		['ищем сетевого инженера', 'network_engineer'],
		['ищем системного администратора', 'sysadmin'],
		['усиливаем команду бизнес-аналитиком', 'business_analyst'],
		['ищем продуктового аналитика', 'product_analyst'],
		['ищем UX-дизайнера', 'ui_ux_designer'],
		['ищем архитектора решений', 'architect']
	])('%s → %s', (title, role) => {
		expect(roleOfTitle(title, roles)).toBe(role);
	});

	it.each(['Архитектура данных', 'Разработка игровых механик', 'Аналитика', 'Ищем инженера'])(
		'reads no role into a word that only looks like a job noun: «%s»',
		(title) => {
			expect(roleOfTitle(title, roles)).toBeNull();
		}
	);

	it('takes the name of a role as written in the taxonomy', () => {
		const [first] = roles;
		if (!first) throw new Error('the taxonomy has no roles');
		expect(roleOfTitle(first.nameRu.toUpperCase(), roles)).toBe(first.key);
	});

	it.each([
		'Программист',
		'Инженер-программист',
		'Менеджер по продажам IT',
		'Копирайтер',
		// Data analysis is the work of both an analyst and a data scientist.
		'Специалист по анализу данных'
	])('names no role for «%s»', (title) => {
		expect(roleOfTitle(title, roles)).toBeNull();
	});

	it('returns only roles of the version', () => {
		expect(roleOfTitle('C++ разработчик', [{ key: 'backend', nameRu: 'Backend-разработчик' }])).toBeNull();
	});
});
