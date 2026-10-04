// The rule of domain.md 12.3: a `manual_override` stands until the desired roles or the grounds of the category
// change — not until any profile field moves `profile_revision` (preferences, work format and catalog visibility move
// it too, domain 13.4, without changing what the category is decided on).
import { describe, expect, it } from 'vitest';
import { matchesBasis, overrideBasisOf } from './job';
import type { CategorizationSnapshot, ClaimInput, ExperienceInput, FactInput } from './types';

function fact(id: string): FactInput {
	return {
		id,
		source: 'fsp',
		factType: 'competition_result',
		sourceRecordRef: `fsp:result:${id}`,
		eventKey: null,
		trustLevel: 'fsp_verified',
		occurredOn: '2026-01-01',
		payload: {}
	};
}

function claim(id: string, factId: string): ClaimInput {
	return {
		id,
		factId,
		claimType: 'skill_mention',
		extractor: 'source_mapping',
		skillKey: 'go',
		eventKey: null,
		polarity: 'asserted',
		candidateReview: 'confirmed',
		experienceEntryId: null,
		value: {}
	};
}

function experience(id: string, factId: string): ExperienceInput {
	return {
		id,
		factId,
		roleKey: 'backend',
		periodFrom: '2024-01',
		periodTo: null,
		periodFromPrecision: 'month',
		periodToPrecision: null,
		isCurrent: true,
		appliedSkillKeys: ['go'],
		periodStatus: 'valid',
		candidateReview: 'confirmed'
	};
}

/** A snapshot with one fact, one claim on it and one experience entry, `revision` and `desiredRoleKeys` overridable. */
function snapshot(overrides: Partial<CategorizationSnapshot> = {}): CategorizationSnapshot {
	return {
		candidateId: '00000000-0000-7000-8000-000000000001',
		revision: 1,
		desiredRoleKeys: ['backend'],
		facts: [fact('fact-1')],
		claims: [claim('claim-1', 'fact-1')],
		experience: [experience('exp-1', 'fact-1')],
		...overrides
	};
}

/** `input_refs` as `insertPublishedRun` stores it for the snapshot's basis (domain 12.1, 12.3). */
function storedInputRefs(of: CategorizationSnapshot) {
	const basis = overrideBasisOf(of);
	return {
		facts: basis.facts,
		claims: basis.claims,
		experience_entries: basis.experienceEntries,
		desired_role_keys: basis.desiredRoleKeys
	};
}

describe('overrideBasisOf / matchesBasis', () => {
	it('keeps matching when only profile_revision moves — a salary, work format or visibility edit', () => {
		const published = snapshot({ revision: 1 });
		const stored = storedInputRefs(published);

		// Same desired roles, same facts/claims/experience; `revision` alone moved (13.4: preferences, work format,
		// catalog visibility bump `profile_revision` without touching the grounds of the category).
		const afterSalaryEdit = snapshot({ revision: 7 });

		expect(matchesBasis(stored, overrideBasisOf(afterSalaryEdit))).toBe(true);
	});

	it('stops matching when the desired roles change', () => {
		const published = snapshot({ revision: 1, desiredRoleKeys: ['backend'] });
		const stored = storedInputRefs(published);

		const afterRoleChange = snapshot({ revision: 2, desiredRoleKeys: ['frontend'] });

		expect(matchesBasis(stored, overrideBasisOf(afterRoleChange))).toBe(false);
	});

	it('stops matching when a ground is added, withdrawn or replaced', () => {
		const published = snapshot({ revision: 1 });
		const stored = storedInputRefs(published);

		const withNewFact = snapshot({
			revision: 2,
			facts: [fact('fact-1'), fact('fact-2')],
			claims: [claim('claim-1', 'fact-1'), claim('claim-2', 'fact-2')]
		});
		expect(matchesBasis(stored, overrideBasisOf(withNewFact))).toBe(false);

		const withoutTheClaim = snapshot({ revision: 2, claims: [] });
		expect(matchesBasis(stored, overrideBasisOf(withoutTheClaim))).toBe(false);
	});

	it('treats a run published before this basis existed as not matching — a conservative default, not a leak', () => {
		const current = overrideBasisOf(snapshot());
		expect(matchesBasis({ facts: [], claims: [] }, current)).toBe(false);
		expect(matchesBasis(null, current)).toBe(false);
		expect(matchesBasis('not an object', current)).toBe(false);
	});

	it('is order-independent: the same sets in a different order still match', () => {
		const published = snapshot({ desiredRoleKeys: ['backend', 'devops'] });
		const stored = storedInputRefs(published);
		const reordered = snapshot({ desiredRoleKeys: ['devops', 'backend'] });
		expect(matchesBasis(stored, overrideBasisOf(reordered))).toBe(true);
	});
});
