// `GET /api/v1/taxonomy/*` (contracts 5.5): dictionaries of the active version, open to everyone.
import { z } from 'zod';
import { defineOperation } from '../operation';
import { activeTaxonomyVersion, listGrades, listRoles, listSkills, listWorkTerms } from '../read/taxonomy';
import { key } from '../schemas';

const version = z
	.object({ id: z.uuid(), label: z.string() })
	.meta({ id: 'TaxonomyVersion', description: 'Версия таксономии, из которой взят справочник' });

const TAG = 'Справочники';

export const listTaxonomyRoles = defineOperation({
	id: 'listTaxonomyRoles',
	method: 'GET',
	path: '/taxonomy/roles',
	tag: TAG,
	summary: 'Роли',
	description: 'Роли активной версии таксономии с семейством ролей.',
	auth: 'public',
	errors: [],
	response: {
		status: 200,
		description: 'Справочник ролей',
		schema: z.object({
			version,
			items: z.array(z.object({ key, family: z.string(), name: z.string() }))
		})
	},
	async handle({ services }) {
		const active = await activeTaxonomyVersion(services.db);
		return { version: active, items: await listRoles(services.db, active.id) };
	}
});

export const listTaxonomySkills = defineOperation({
	id: 'listTaxonomySkills',
	method: 'GET',
	path: '/taxonomy/skills',
	tag: TAG,
	summary: 'Навыки',
	description: 'Навыки активной версии: вид, родительский навык и нормализованные синонимы.',
	auth: 'public',
	errors: [],
	response: {
		status: 200,
		description: 'Справочник навыков',
		schema: z.object({
			version,
			items: z.array(
				z.object({
					key,
					kind: z.enum([
						'language',
						'framework',
						'library',
						'runtime',
						'platform',
						'database',
						'tool',
						'practice',
						'domain'
					]),
					parent_key: key.nullable(),
					name: z.string(),
					aliases: z.array(z.string())
				})
			)
		})
	},
	async handle({ services }) {
		const active = await activeTaxonomyVersion(services.db);
		const items = await listSkills(services.db, active.id);
		return {
			version: active,
			items: items.map((skill) => ({
				key: skill.key,
				kind: skill.kind,
				parent_key: skill.parentKey,
				name: skill.name,
				aliases: skill.aliases
			}))
		};
	}
});

export const listTaxonomyGrades = defineOperation({
	id: 'listTaxonomyGrades',
	method: 'GET',
	path: '/taxonomy/grades',
	tag: TAG,
	summary: 'Грейды',
	description: 'Грейды активной версии по возрастанию.',
	auth: 'public',
	errors: [],
	response: {
		status: 200,
		description: 'Справочник грейдов',
		schema: z.object({ version, items: z.array(z.object({ key, ordinal: z.int(), name: z.string() })) })
	},
	async handle({ services }) {
		const active = await activeTaxonomyVersion(services.db);
		return { version: active, items: await listGrades(services.db, active.id) };
	}
});

export const listTaxonomyWorkTerms = defineOperation({
	id: 'listTaxonomyWorkTerms',
	method: 'GET',
	path: '/taxonomy/work-terms',
	tag: TAG,
	summary: 'Формат, занятость, оформление',
	description:
		'Значения измерений `work_format`, `employment_form` и `contract_type` активной версии — поля вакансии и ' +
		'предпочтений кандидата.',
	auth: 'public',
	errors: [],
	response: {
		status: 200,
		description: 'Справочник условий работы',
		schema: z.object({
			version,
			items: z.array(z.object({ dimension: z.string(), key, name: z.string() }))
		})
	},
	async handle({ services }) {
		const active = await activeTaxonomyVersion(services.db);
		return { version: active, items: await listWorkTerms(services.db, active.id) };
	}
});
