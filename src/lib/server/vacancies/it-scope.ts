// Whether a normalized posting belongs to the IT market the aggregator covers (docs/domain.md, section 13.2). A source
// whose listing mixes industries (Habr Career: marketing, sales, pharma) is filtered on import by the taxonomy, as the
// adapter of «Работа России» filters by the category of the portal: a posting stays when its title names an IT role
// or its skills include an IT skill. The rules are deterministic; what they do not recognize is not IT.
import type { NormalizedPosting } from './normalize';

/**
 * Skills every industry asks for: they do not make a posting IT. Keys of the taxonomy (`taxonomy/skills.json`).
 */
const GENERAL_SKILLS: ReadonlySet<string> = new Set([
	'teamwork',
	'presentation',
	'english',
	'excel',
	'project_management',
	'product_management',
	// Support of customers and of equipment and presales exist in any industry («Сервисный инженер»: ремонт ПК,
	// наладка оборудования; presale of an equipment supplier): the product makes them IT, not the practice.
	'technical_support',
	'presale'
]);

/**
 * Roles whose titles other industries use as well («Product Manager» of a pharmaceutical brand, «Менеджер проектов»
 * of a construction company, «Delivery Manager» of a courier service, «Пресейл-инженер» of an equipment supplier): the
 * title alone is not enough, an IT skill has to confirm it.
 */
const SHARED_TITLE_ROLES: ReadonlySet<string> = new Set([
	'product_manager',
	'project_manager',
	'delivery_manager',
	'presale'
]);

export type ItScope =
	{ it: true; basis: 'role' | 'skills'; itSkills: string[] } | { it: false; basis: 'none'; itSkills: [] };

/** IT skills of a posting: required and nice-to-have ones the taxonomy knows, without the general ones. */
function itSkillsOf(normalized: NormalizedPosting): string[] {
	return [...normalized.skills.required, ...normalized.skills.nice].filter((key) => !GENERAL_SKILLS.has(key));
}

/**
 * IT by the role of the title (unless the title is shared with other industries), else by at least one IT skill. A
 * posting without a recognized role but with IT skills stays: tags of a source name the stack more reliably than titles
 * like «Младший инженер ЦОД» that the title rules do not know.
 */
export function itScopeOf(normalized: NormalizedPosting): ItScope {
	const itSkills = itSkillsOf(normalized);
	const role = normalized.role.key;
	if (role !== null && !SHARED_TITLE_ROLES.has(role)) return { it: true, basis: 'role', itSkills };
	if (itSkills.length > 0) return { it: true, basis: 'skills', itSkills };
	return { it: false, basis: 'none', itSkills: [] };
}
