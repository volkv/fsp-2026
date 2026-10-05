import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPECIALIZATION_KEYS } from '$lib/server/assessments/contract/catalog';
import {
	primarySpecializationOfRole,
	REFERENCE_ROLES,
	ROLE_SPECIALIZATIONS,
	rolesOfSpecialization,
	specializationsOfRole
} from './roles';

const roles = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../../taxonomy/roles.json', import.meta.url)), 'utf8')
) as { roles: { key: string }[] };

describe('role → specialization', () => {
	it('decides every role of the taxonomy, and no other', () => {
		expect(Object.keys(ROLE_SPECIALIZATIONS).sort()).toEqual(roles.roles.map((r) => r.key).sort());
	});

	it('reaches every specialization of the catalog from some role', () => {
		for (const specialization of SPECIALIZATION_KEYS) {
			expect(rolesOfSpecialization(specialization), specialization).not.toEqual([]);
		}
	});

	it('maps a role to the specializations testing its work, and an untested role to none', () => {
		expect(specializationsOfRole('fullstack')).toEqual(['backend', 'frontend']);
		expect(specializationsOfRole('qa_automation')).toEqual(['qa']);
		expect(specializationsOfRole('onec')).toEqual([]);
		expect(rolesOfSpecialization('qa')).toEqual(['qa_automation', 'qa_manual']);
	});

	it('throws on a role nobody decided about', () => {
		expect(() => specializationsOfRole('astronaut')).toThrow(/no decision/);
	});
});

describe('reference roles', () => {
	it('names for every specialization a role that maps to it', () => {
		for (const specialization of SPECIALIZATION_KEYS) {
			expect(specializationsOfRole(REFERENCE_ROLES[specialization])).toContain(specialization);
		}
	});
});

describe('the primary specialization of a role', () => {
	it('is the first of its specializations, none for a role no test checks', () => {
		expect(primarySpecializationOfRole('fullstack')).toBe('backend');
		expect(primarySpecializationOfRole('data_analyst')).toBeNull();
	});
});
