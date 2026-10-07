import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vacancies } from '$lib/server/db/schema';
import { moderationCaseOf } from '$lib/server/vacancies/own';
import { textCheckSchema } from '$lib/server/vacancies/text-check';
import { createTestDatabase, MIGRATIONS_FOLDER, type TestDatabase } from '../helpers/database';
import { createCompany, createMember, createOwnVacancy, createTaxonomyVersion } from '../helpers/factories';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.drop();
});

/** The data statements of a migration, to run again over rows built as they were before it: its schema changes are applied. */
async function dataStatements(file: string): Promise<string[]> {
	const text = await readFile(join(MIGRATIONS_FOLDER, file), 'utf8');
	return text
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => !/^ALTER TABLE/mu.test(statement));
}

describe('migrations', () => {
	it('apply from scratch and record every migration file', async () => {
		const files = (await readdir(MIGRATIONS_FOLDER)).filter((name) => name.endsWith('.sql'));
		const applied = await database.sql<{ count: string }[]>`select count(*) from drizzle.__drizzle_migrations`;
		expect(Number(applied[0]?.count)).toBe(files.length);
	});

	it('are idempotent when applied again', async () => {
		const { migrate } = await import('drizzle-orm/postgres-js/migrator');
		await expect(migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.toBeUndefined();
	});

	it('partition the journal by month around the current date', async () => {
		const partitions = await database.sql<{ name: string }[]>`
			select child.relname as name
			from pg_inherits
			join pg_class parent on parent.oid = pg_inherits.inhparent
			join pg_class child on child.oid = pg_inherits.inhrelid
			where parent.relname = 'audit_events'`;
		const now = new Date();
		const current = `audit_events_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
		expect(partitions.map((p) => p.name)).toContain(current);
		expect(partitions.length).toBe(27);
	});

	it('create no approximate vector index', async () => {
		const indexes = await database.sql<{ indexdef: string }[]>`
			select indexdef from pg_indexes where schemaname = 'public' and indexdef ilike '%hnsw%'`;
		expect(indexes).toEqual([]);
	});

	it('give every stored text check a moderation case key, keeping the cases already there', async () => {
		const { db } = database;
		const company = await createCompany(db);
		const member = await createMember(db, company.id);
		const taxonomy = await createTaxonomyVersion(db);
		const input = { companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id };
		const old = await createOwnVacancy(db, input);
		const moderation = { opened_at: '2026-09-20T08:00:00.000Z', resume_to: 'paused', decision: null } as const;
		const pending = await createOwnVacancy(db, input, {
			status: 'pending_moderation',
			publishedAt: null,
			textCheck: { validator_version: 'test', result: 'blocked', phrases: [], warnings_confirmed: null, moderation }
		});
		// A check as it was stored before moderation cases were kept: without the key.
		await database.sql`update vacancies set text_check = text_check - 'moderation' where id = ${old.id}`;

		const statement = await readFile(join(MIGRATIONS_FOLDER, '0018_text_check_moderation_key.sql'), 'utf8');
		for (let run = 0; run < 2; run++) await database.sql.unsafe(statement);

		const checkOf = async (id: string) =>
			(await db.select({ textCheck: vacancies.textCheck }).from(vacancies).where(eq(vacancies.id, id)))[0]?.textCheck;
		expect(await checkOf(old.id)).toEqual({
			validator_version: 'test',
			result: 'clean',
			phrases: [],
			warnings_confirmed: null,
			moderation: null
		});
		expect(await checkOf(pending.id)).toMatchObject({ moderation });
	});

	it('open a moderation case for a vacancy that waited in moderation before cases were kept', async () => {
		const { db } = database;
		const company = await createCompany(db);
		const member = await createMember(db, company.id);
		const taxonomy = await createTaxonomyVersion(db);
		const input = { companyId: company.id, memberId: member.id, taxonomyVersionId: taxonomy.id };
		const blocked = { validator_version: 'test', result: 'blocked', phrases: [], warnings_confirmed: null } as const;
		const stuck = await createOwnVacancy(db, input, {
			status: 'pending_moderation',
			publishedAt: null,
			textCheck: { ...blocked, moderation: null }
		});
		const moderation = { opened_at: '2026-09-20T08:00:00.000Z', resume_to: 'paused', decision: null } as const;
		const open = await createOwnVacancy(db, input, {
			status: 'pending_moderation',
			publishedAt: null,
			textCheck: { ...blocked, moderation }
		});
		const listed = await createOwnVacancy(db, input);
		const changedAt = new Date('2026-09-18T10:11:12.345Z');
		await db.update(vacancies).set({ updatedAt: changedAt }).where(eq(vacancies.id, stuck.id));
		const [statement] = (await dataStatements('0023_unknown_skill_last_seen_moderation_case.sql')).filter((text) =>
			text.includes('UPDATE "vacancies"')
		);
		if (!statement) throw new Error('the migration has no statement for vacancies in moderation');
		for (let run = 0; run < 2; run++) await database.sql.unsafe(statement);

		const checkOf = async (id: string) =>
			textCheckSchema.parse(
				(await db.select({ textCheck: vacancies.textCheck }).from(vacancies).where(eq(vacancies.id, id)))[0]?.textCheck
			);
		expect(moderationCaseOf(await checkOf(stuck.id))).toEqual({
			opened_at: changedAt.toISOString(),
			resume_to: 'published',
			decision: null
		});
		expect((await checkOf(open.id)).moderation).toEqual(moderation);
		expect((await checkOf(listed.id)).moderation).toBeNull();
	});
});
