// A role of a vacancy → the specializations of the catalog (docs/domain.md, section 12.10). Vacancies, salary
// references and the market speak in roles of the taxonomy (backend, data_analyst, sre…); a category
// is a specialization of the catalog. A role maps to the specializations whose test checks the core work of the role:
// a candidate with a category of one of them is a candidate of that role's vacancies. A role whose work no test of the
// catalog checks (1C, game engines, security, management, design…) maps to none: its vacancies have no category, and
// the role component of the ranking for them stays «unknown» rather than guessed.
//
// Data of this module, versioned: a unit test keeps it equal to the role list of the taxonomy, so a new role cannot
// appear without a decision about it.
import type { SpecializationKey } from '$lib/server/assessments/contract/catalog';

export const ROLE_SPECIALIZATIONS_VERSION = 'role-specialization/1';

export const ROLE_SPECIALIZATIONS: Readonly<Record<string, readonly SpecializationKey[]>> = {
	backend: ['backend'],
	frontend: ['frontend'],
	// Both halves of the work are tested, each by its own specialization.
	fullstack: ['backend', 'frontend'],
	mobile: ['mobile'],
	gamedev: [],
	embedded: [],
	systems_programmer: [],
	onec: [],
	algo_engineer: [],
	robotics_engineer: [],
	uav_engineer: [],
	architect: [],
	qa_manual: ['qa'],
	qa_automation: ['qa'],
	systems_analyst: [],
	business_analyst: [],
	// Analysts and data engineers are not tested by Data Science / ML: its practice and blocks are about models.
	data_analyst: [],
	product_analyst: [],
	data_engineer: [],
	data_scientist: ['data_ml'],
	ml_engineer: ['data_ml'],
	cv_engineer: ['data_ml'],
	// Delivery of models: ML work first, the DevOps part second.
	mlops: ['data_ml', 'devops'],
	devops: ['devops'],
	sre: ['devops'],
	sysadmin: [],
	sam_specialist: [],
	network_engineer: [],
	dba: [],
	pentester: [],
	appsec: [],
	soc_analyst: [],
	security_engineer: [],
	reverse_engineer: [],
	team_lead: [],
	product_manager: [],
	project_manager: [],
	delivery_manager: [],
	cto: [],
	ui_ux_designer: [],
	tech_support: [],
	tech_writer: [],
	presale: []
};

/** The specializations a role of the taxonomy maps to; a role the mapping does not know is a defect and throws. */
export function specializationsOfRole(roleKey: string): readonly SpecializationKey[] {
	const mapped = ROLE_SPECIALIZATIONS[roleKey];
	if (mapped === undefined) {
		throw new Error(`role ${roleKey} has no decision in ${ROLE_SPECIALIZATIONS_VERSION}`);
	}
	return mapped;
}

/**
 * The one specialization a role names, for what takes a single one — the specialization of a need read from its title:
 * the first of `specializationsOfRole`; `null` — the role is of none.
 */
export function primarySpecializationOfRole(roleKey: string): SpecializationKey | null {
	return specializationsOfRole(roleKey)[0] ?? null;
}

/** The roles whose vacancies a specialization serves: the inverse of the mapping, sorted. */
export function rolesOfSpecialization(specialization: SpecializationKey): string[] {
	return Object.entries(ROLE_SPECIALIZATIONS)
		.filter(([, specializations]) => specializations.includes(specialization))
		.map(([role]) => role)
		.sort();
}

/**
 * The role whose external salary reference stands for a specialization in the market (domain 12.8, 12.10): the
 * reference is collected by roles, and the role closest to what the specialization's test checks speaks for it.
 */
export const REFERENCE_ROLES: Readonly<Record<SpecializationKey, string>> = {
	backend: 'backend',
	frontend: 'frontend',
	mobile: 'mobile',
	data_ml: 'data_scientist',
	// From Junior on the QA test checks automation (`qa.auto`), and its practice is test cases run against mutants.
	qa: 'qa_automation',
	devops: 'devops'
};
