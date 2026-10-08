// The disclosure fields a candidate's profile has nothing for: the acceptance and the application forms say so next to
// the field instead of offering to disclose an empty one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDisclosureFields } from '$lib/server/invitations/consent';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate } from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

describe('empty disclosure fields', () => {
	it('names the optional contacts the profile has no value for', async () => {
		const { db } = database;
		const withPhone = await createCandidate(db, { phoneEnc: new Uint8Array([1, 2, 3]) });
		const withTelegram = await createCandidate(db, { telegramEnc: new Uint8Array([4, 5, 6]) });

		expect(await emptyDisclosureFields(db, withPhone.id)).toEqual(['telegram', 'resume']);
		expect(await emptyDisclosureFields(db, withTelegram.id)).toEqual(['phone', 'resume']);
	});
});
