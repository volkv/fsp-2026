import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { DEFAULT_SEED } from '../src/config.ts';
import { CATALOG } from '../src/seed/catalog.ts';
import { DATASET_AS_OF, generateWorld } from '../src/seed/generate.ts';
import { hero } from '../src/seed/heroes.ts';
import type { World } from '../src/store.ts';
import { DISCIPLINE_CODES, type Result } from '../src/types.ts';

const world = generateWorld({ seed: DEFAULT_SEED, athletes: 3000 });

function resultsOf(w: World, fspId: string): Result[] {
	const record = w.athletes.get(fspId);
	assert.ok(record, `athlete ${fspId}`);
	return record.results;
}

function competitionOf(w: World, result: Result) {
	const competition = w.competitions.get(result.competitionId);
	assert.ok(competition);
	return competition;
}

describe('generated dataset', () => {
	it('is deterministic for the same seed and differs for another seed', () => {
		const again = generateWorld({ seed: DEFAULT_SEED, athletes: 3000 });
		assert.equal(again.datasetId, world.datasetId);
		assert.deepEqual([...again.athletes.entries()].slice(0, 50), [...world.athletes.entries()].slice(0, 50));
		const other = generateWorld({ seed: 'another', athletes: 3000 });
		assert.notEqual(other.datasetId, world.datasetId);
		assert.notDeepEqual([...other.athletes.keys()].slice(20, 30), [...world.athletes.keys()].slice(20, 30));
	});

	it('has the requested number of athletes, with results in all five disciplines', () => {
		assert.equal(world.athletes.size, 3000);
		const withResults = [...world.athletes.values()].filter((r) => r.results.length > 0).length;
		assert.ok(withResults > 1500, `${withResults} athletes with results`);
		const disciplines = new Set(
			[...world.athletes.values()].flatMap((r) =>
				r.results.map((x) => world.competitions.get(x.competitionId)?.discipline)
			)
		);
		for (const code of DISCIPLINE_CODES) assert.ok(disciplines.has(code), code);
	});

	it('keeps places consistent: one entry per person and competition, places within the field', () => {
		for (const record of world.athletes.values()) {
			const seen = new Set<string>();
			for (const result of record.results) {
				assert.ok(!seen.has(result.competitionId), `${record.athlete.fspId} twice in ${result.competitionId}`);
				seen.add(result.competitionId);
				if (result.place !== null) assert.ok(result.place >= 1 && result.place <= (result.placeOf ?? Infinity));
			}
		}
		const individualPlaces = new Map<string, Set<number>>();
		for (const record of world.athletes.values()) {
			for (const r of record.results) {
				if (r.team !== null || r.place === null) continue;
				const places = individualPlaces.get(r.competitionId) ?? new Set<number>();
				assert.ok(!places.has(r.place), `place ${r.place} repeated in ${r.competitionId}`);
				places.add(r.place);
				individualPlaces.set(r.competitionId, places);
			}
		}
	});

	it('uses real competitions only and none after the dataset date', () => {
		const catalogIds = new Set(CATALOG.map((c) => c.id));
		for (const record of world.athletes.values()) {
			for (const r of record.results) {
				assert.ok(catalogIds.has(r.competitionId));
				assert.ok(competitionOf(world, r).startDate <= DATASET_AS_OF);
			}
		}
		assert.ok(CATALOG.filter((c) => c.ekpNumber !== null).every((c) => /^\d{16}$/.test(c.ekpNumber ?? '')));
	});

	it('assigns ranks only from fulfilled norms, never from a qualifier, and records the basis', () => {
		for (const record of world.athletes.values()) {
			for (const q of record.qualifications) {
				if (q.basisCompetitionId === null || q.basisCompetitionId === undefined) continue;
				const basis = record.results.find((r) => r.competitionId === q.basisCompetitionId);
				assert.ok(basis, 'basis competition is among the results');
				assert.equal(basis.evskFulfilled, q.rank);
				assert.notEqual(world.competitions.get(q.basisCompetitionId)?.stage, 'qualifier');
			}
		}
	});

	it('covers the demo scenarios', () => {
		const minors = ['teen_14', 'teen_16'].map((k) => hero(k));
		for (const m of minors) {
			const age = Number(DATASET_AS_OF.slice(0, 4)) - m.birthYear;
			assert.ok(age >= 14 && age <= 17, `${m.key} is ${age}`);
			assert.ok(resultsOf(world, m.fspId).length > 0);
		}

		const noSpec = resultsOf(world, hero('team_no_spec').fspId).find((r) => r.award === 'prize');
		assert.ok(noSpec?.team, 'team prize');
		assert.equal(noSpec.team.specialization ?? null, null);
		assert.equal(noSpec.evskFulfilled, 'KMS');
		assert.equal(
			world.athletes.get(hero('team_no_spec').fspId)?.qualifications.length,
			0,
			'norm fulfilled, rank not assigned'
		);

		const [qualifier, final] = ['qualifier', 'final'].map((stage) =>
			resultsOf(world, hero('online_vs_final').fspId).find((r) => competitionOf(world, r).stage === stage)
		);
		assert.ok(qualifier && final);
		assert.equal(competitionOf(world, qualifier).online, true);
		assert.equal(competitionOf(world, final).online, false);
		assert.equal(
			competitionOf(world, qualifier).startDate.slice(0, 4),
			competitionOf(world, final).startDate.slice(0, 4)
		);
		assert.ok((qualifier.place ?? 0) < (final.place ?? 0));

		const captain = world.athletes.get(hero('captain_backend').fspId);
		assert.ok(captain);
		assert.ok(captain.qualifications.some((q) => q.rank === 'MS'));
		assert.ok(captain.results.some((r) => r.team?.role === 'captain' && r.team.specialization === 'backend'));

		const statuses = new Set(resultsOf(world, hero('annulled').fspId).map((r) => r.status));
		assert.ok(statuses.has('annulled') && statuses.has('preliminary'));

		assert.ok(resultsOf(world, hero('long_history').fspId).length > 20);
		assert.equal(resultsOf(world, hero('no_results').fspId).length, 0);
		assert.equal(world.athletes.get(hero('algo_kms').fspId)?.athlete.nationalTeam?.squad, 'reserve');
	});

	it('has an FSP ID account for every athlete, with the athlete id as subject', () => {
		for (const fspId of world.athletes.keys()) assert.equal(world.accounts.get(fspId)?.sub, fspId);
		const emails = [...world.accounts.values()].map((a) => a.email);
		assert.equal(new Set(emails).size, emails.length, 'emails are unique');
		assert.ok(emails.every((e) => e.endsWith('@example.com')));
	});
});
