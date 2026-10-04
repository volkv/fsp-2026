import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

import { hero } from '../src/seed/heroes.ts';
import type { AchievementsPage } from '../src/types.ts';
import { control, login, startMock, type RunningMock } from './helpers.ts';

interface Snapshot {
	pages: AchievementsPage[];
	complete: boolean;
	reason?: 'version_changed' | 'source_declared_partial' | 'no_completeness_signal';
}

/** Walks all pages the way the platform adapter does (docs/contracts.md, section 1.3). */
async function snapshot(mock: RunningMock, fspId: string, token: string, pageSize: number): Promise<Snapshot> {
	const pages: AchievementsPage[] = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`${mock.origin}/v1/athletes/${fspId}/achievements?page=${page}&pageSize=${pageSize}`, {
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(response.status, 200);
		const body = (await response.json()) as AchievementsPage;
		assert.equal(response.headers.get('etag'), `"${body.sourceVersion}"`);
		pages.push(body);
		if (page >= body.page.totalPages) break;
	}
	const versions = new Set(pages.map((p) => p.sourceVersion));
	if (versions.size > 1) return { pages, complete: false, reason: 'version_changed' };
	if (pages.some((p) => p.complete === undefined)) return { pages, complete: false, reason: 'no_completeness_signal' };
	if (pages.some((p) => !p.complete)) return { pages, complete: false, reason: 'source_declared_partial' };
	return { pages, complete: true };
}

describe('achievements snapshot', () => {
	let mock: RunningMock;
	const athlete = hero('long_history');
	let token: string;

	beforeAll(async () => {
		mock = await startMock();
		token = (await login(mock, athlete.fspId)).access_token;
	});
	afterAll(() => mock.close());
	beforeEach(async () => {
		await control(mock, '/mock/faults', { method: 'DELETE' });
	});

	it('pages through every result exactly once within one source version', async () => {
		const snap = await snapshot(mock, athlete.fspId, token, 5);
		assert.equal(snap.complete, true);
		const total = snap.pages[0]?.page.totalResults ?? 0;
		assert.ok(total > 20, `long history expected, got ${total}`);
		assert.equal(snap.pages.length, Math.ceil(total / 5));
		const ids = snap.pages.flatMap((p) => p.results.map((r) => r.id));
		assert.equal(ids.length, total);
		assert.equal(new Set(ids).size, total, 'no result is repeated across pages');
		for (const page of snap.pages) {
			const referenced = new Set(page.results.map((r) => r.competitionId));
			assert.deepEqual(new Set(page.competitions.map((c) => c.id)), referenced, 'each page carries its competitions');
		}
	});

	it('keeps result ids stable between snapshots', async () => {
		const first = (await snapshot(mock, athlete.fspId, token, 50)).pages.flatMap((p) => p.results.map((r) => r.id));
		const second = (await snapshot(mock, athlete.fspId, token, 7)).pages.flatMap((p) => p.results.map((r) => r.id));
		assert.deepEqual(new Set(second), new Set(first));
	});

	it('changes sourceVersion when the source data changes between pages', async () => {
		const set = await control(mock, '/mock/faults', {
			method: 'PUT',
			body: JSON.stringify({ mode: 'version_changed', athleteId: athlete.fspId, remaining: 1 })
		});
		assert.equal(set.status, 200);
		const snap = await snapshot(mock, athlete.fspId, token, 5);
		assert.equal(snap.complete, false);
		assert.equal(snap.reason, 'version_changed');
	});

	it('declares a partial snapshot and can withhold the completeness signal', async () => {
		await control(mock, '/mock/faults', {
			method: 'PUT',
			body: JSON.stringify({ mode: 'partial', athleteId: athlete.fspId, remaining: 1 })
		});
		assert.equal((await snapshot(mock, athlete.fspId, token, 50)).reason, 'source_declared_partial');
		await control(mock, '/mock/faults', {
			method: 'PUT',
			body: JSON.stringify({ mode: 'no_completeness_signal', athleteId: athlete.fspId, remaining: 1 })
		});
		assert.equal((await snapshot(mock, athlete.fspId, token, 50)).reason, 'no_completeness_signal');
	});

	it('answers 503 unavailable and 429 rate_limited with Retry-After on request', async () => {
		await control(mock, '/mock/faults', { method: 'PUT', body: JSON.stringify({ mode: 'unavailable', remaining: 1 }) });
		const unavailable = await fetch(`${mock.origin}/v1/athletes/${athlete.fspId}/achievements`, {
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(unavailable.status, 503);
		await control(mock, '/mock/faults', {
			method: 'PUT',
			body: JSON.stringify({ mode: 'rate_limited', remaining: 1 })
		});
		const limited = await fetch(`${mock.origin}/v1/athletes/${athlete.fspId}/achievements`, {
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get('retry-after'), '2');
		const recovered = await fetch(`${mock.origin}/v1/athletes/${athlete.fspId}/achievements`, {
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(recovered.status, 200);
	});

	it('refuses a page beyond the last one and invalid page parameters', async () => {
		for (const query of ['page=999', 'page=0', 'pageSize=101', 'page=abc']) {
			const response = await fetch(`${mock.origin}/v1/athletes/${athlete.fspId}/achievements?${query}`, {
				headers: { authorization: `Bearer ${token}` }
			});
			assert.equal(response.status, 400, query);
		}
	});

	it('returns an empty but complete snapshot for an athlete without results', async () => {
		const empty = hero('no_results');
		const own = (await login(mock, empty.fspId)).access_token;
		const snap = await snapshot(mock, empty.fspId, own, 20);
		assert.equal(snap.complete, true);
		const [only] = snap.pages;
		assert.ok(only && snap.pages.length === 1);
		assert.deepEqual(only.results, []);
		assert.equal(only.page.totalPages, 1);
	});
});
