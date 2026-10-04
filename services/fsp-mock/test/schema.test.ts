import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { ASSERTION_HEADER, encodeAssertion, signAssertion } from '../src/api/grants.ts';
import { HEROES } from '../src/seed/heroes.ts';
import { ASSERTION_SECRET, control, login, serviceToken, startMock, type RunningMock } from './helpers.ts';

const SCHEMA = JSON.parse(
	await readFile(new URL('../../../contracts/fsp-achievements/v1.schema.json', import.meta.url), 'utf8')
) as { $defs: Record<string, unknown> };

/**
 * The published schema keeps objects open (optional fields may be added within v1). For the simulator's own answers
 * the test closes every object, so a field outside the contract is caught too.
 */
function closed(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(closed);
	if (typeof node !== 'object' || node === null) return node;
	const copy = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, closed(v)]));
	if ('properties' in copy && copy.type === 'object' && !('additionalProperties' in copy))
		copy.additionalProperties = false;
	return copy;
}

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

function validators(strict: boolean): (def: string) => ValidateFunction {
	const ajv = new Ajv2020({ allErrors: true, strict: true });
	addFormats(ajv);
	ajv.addSchema(strict ? (closed(SCHEMA) as object) : SCHEMA, 'fsp-achievements');
	return (def) => {
		const validate = ajv.getSchema(`fsp-achievements#/$defs/${def}`);
		if (!validate) throw new Error(`no $defs/${def}`);
		return validate;
	};
}

function check(validate: ValidateFunction, value: unknown, what: string): void {
	assert.ok(validate(value), `${what}: ${JSON.stringify(validate.errors?.slice(0, 5))}`);
}

describe('responses match contracts/fsp-achievements/v1.schema.json', () => {
	let mock: RunningMock;
	const schema = validators(true);

	beforeAll(async () => {
		mock = await startMock();
	});
	afterAll(() => mock.close());

	it('disciplines, competition list and every competition', async () => {
		check(schema('DisciplineList'), await (await fetch(`${mock.origin}/v1/disciplines`)).json(), 'disciplines');
		const list = (await (await fetch(`${mock.origin}/v1/competitions?pageSize=100`)).json()) as {
			items: { id: string }[];
		};
		check(schema('CompetitionList'), list, 'competition list');
		assert.equal(list.items.length, mock.app.store.world.competitions.size);
		for (const { id } of list.items) {
			check(schema('Competition'), await (await fetch(`${mock.origin}/v1/competitions/${id}`)).json(), id);
		}
	});

	it('achievement pages of every demo athlete (user token)', async () => {
		for (const h of HEROES) {
			const token = (await login(mock, h.fspId, 'openid fsp_achievements')).access_token;
			const response = await fetch(`${mock.origin}/v1/athletes/${h.fspId}/achievements?pageSize=100`, {
				headers: { authorization: `Bearer ${token}` }
			});
			check(schema('AchievementsPage'), await response.json(), h.key);
			const athlete = await fetch(`${mock.origin}/v1/athletes/${h.fspId}`, {
				headers: { authorization: `Bearer ${token}` }
			});
			check(schema('Athlete'), await athlete.json(), `${h.key} profile`);
		}
	});

	it('achievement pages of every generated athlete (service token with assertion)', async () => {
		const token = await serviceToken(mock);
		for (const fspId of mock.app.store.world.athletes.keys()) {
			const now = new Date();
			const value = encodeAssertion(
				signAssertion(
					{
						sourceAthleteId: fspId,
						consentEventId: 'c-1',
						issuedAt: now.toISOString(),
						expiresAt: new Date(now.getTime() + 60_000).toISOString()
					},
					ASSERTION_SECRET
				)
			);
			const response = await fetch(`${mock.origin}/v1/athletes/${fspId}/achievements?pageSize=100`, {
				headers: { authorization: `Bearer ${token}`, [ASSERTION_HEADER]: value }
			});
			assert.equal(response.status, 200);
			check(schema('AchievementsPage'), await response.json(), fspId);
		}
	});

	it('error bodies, webhook events and subscriptions', async () => {
		const error = await fetch(`${mock.origin}/v1/athletes/x/achievements`);
		check(schema('Error'), await error.json(), 'error');
		const dispatched = await control(mock, '/mock/webhooks/dispatch', {
			method: 'POST',
			body: JSON.stringify({ type: 'athlete.updated', athleteIds: [HEROES[0]?.fspId] })
		});
		check(schema('WebhookEvent'), ((await dispatched.json()) as { event: unknown }).event, 'webhook event');
		const token = await serviceToken(mock);
		const subscription = await fetch(`${mock.origin}/v1/webhooks`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ url: 'http://127.0.0.1:9/hook', events: ['athlete.updated'], secret: 'x'.repeat(32) })
		});
		check(schema('WebhookSubscription'), await subscription.json(), 'subscription');
	});

	it('a malformed page (fault injection) violates the published schema, as the adapter must detect', async () => {
		const open = validators(false);
		const h = HEROES[0];
		assert.ok(h);
		const token = (await login(mock, h.fspId, 'openid fsp_achievements')).access_token;
		await control(mock, '/mock/faults', { method: 'PUT', body: JSON.stringify({ mode: 'malformed', remaining: 1 }) });
		const response = await fetch(`${mock.origin}/v1/athletes/${h.fspId}/achievements`, {
			headers: { authorization: `Bearer ${token}` }
		});
		assert.equal(open('AchievementsPage')(await response.json()), false);
	});

	it('unknown enumeration values arrive as unknown with the raw value', () => {
		const results = [...mock.app.store.world.athletes.values()].flatMap((r) => r.results);
		const unknownRole = results.find((r) => r.team?.role === 'unknown');
		assert.ok(unknownRole?.rawValues?.['team.role']);
		const unknownLevel = [...mock.app.store.world.competitions.values()].find((c) => c.level === 'unknown');
		assert.ok(unknownLevel?.rawValues?.level);
	});
});
