// The cast of the demo scenario (`seeds/demo.json`): the accounts a visitor may act as — the heroes К-1…, the members
// of the scenario companies Ю-1…, the FSP operator and the administrator — and their originals seeded on the stand.
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Executor } from '$lib/server/db';
import { candidates, companies, companyMembers, users } from '$lib/server/db/schema';
import type { SeedData } from './data';

export type CastGroup = 'candidate' | 'employer' | 'staff';

export interface CastRole {
	/** `candidate:k1`, `member:severny_kod_recruiter`, `staff:operator`. */
	key: string;
	group: CastGroup;
	/** К-1, Ю-1, … as the scenario names them; the staff have none. */
	code: string | null;
	/** What the role is in the scenario, beside the person's name. */
	part: string;
	email: string;
	/** Where the session of the role starts. */
	home: '/me' | '/company' | '/operator' | '/admin';
}

/** The roles of the cast in the order of `seeds/demo.json`. */
export function castRoles(data: SeedData): CastRole[] {
	const roles: CastRole[] = data.demo.candidates.map((hero, index) => ({
		key: `candidate:${hero.key}`,
		group: 'candidate',
		code: `К-${index + 1}`,
		part: hero.part,
		email: hero.email,
		home: '/me'
	}));
	data.demo.companies.forEach((company, index) => {
		for (const member of company.members) {
			roles.push({
				key: `member:${member.key}`,
				group: 'employer',
				code: `Ю-${index + 1}`,
				part: `${member.role === 'owner' ? 'владелец' : 'рекрутер'} «${company.displayName}»${
					company.status === 'submitted' ? ', компания на проверке' : ''
				}`,
				email: member.email,
				home: '/company'
			});
		}
	});
	for (const staff of data.demo.staff) {
		roles.push({
			key: `staff:${staff.key}`,
			group: 'staff',
			code: null,
			part: staff.role === 'operator' ? 'оператор ФСП' : 'администратор платформы',
			email: staff.email,
			home: staff.role === 'operator' ? '/operator' : '/admin'
		});
	}
	return roles;
}

export interface CastOriginals {
	/** The seed batch of the originals. */
	batch: string;
	/** Original account of each role key. */
	users: Map<string, { id: string; displayName: string | null }>;
	companyIds: string[];
	candidateIds: string[];
}

export class DemoCastMissing extends Error {
	override name = 'DemoCastMissing';
}

/**
 * The seeded originals of the cast: accounts found by their addresses among demo accounts outside any demo session,
 * the scenario companies they are members of, and the heroes' profiles. A cast that is not seeded (or seeded by two
 * batches) is refused.
 */
export async function castOriginals(
	executor: Executor,
	crypto: FieldCrypto,
	roles: readonly CastRole[]
): Promise<CastOriginals> {
	const byHmac = new Map(roles.map((role) => [crypto.lookupHmac('email', role.email), role]));
	const rows = await executor
		.select({ id: users.id, hmac: users.emailHmac, name: users.displayName, batch: users.seedBatchId })
		.from(users)
		.where(and(inArray(users.emailHmac, [...byHmac.keys()]), ne(users.status, 'deleted'), isNull(users.demoSessionId)));
	const found = new Map<string, { id: string; displayName: string | null }>();
	const batches = new Set<string>();
	for (const row of rows) {
		const role = row.hmac === null ? undefined : byHmac.get(row.hmac);
		if (!role || row.batch === null) continue;
		found.set(role.key, { id: row.id, displayName: row.name });
		batches.add(row.batch);
	}
	const absent = roles.filter((role) => !found.has(role.key)).map((role) => role.key);
	if (absent.length > 0) throw new DemoCastMissing(`the demo cast is not seeded: ${absent.join(', ')}`);
	const [batch, ...others] = batches;
	if (batch === undefined || others.length > 0) {
		throw new DemoCastMissing(`the demo cast belongs to batches ${[...batches].join(', ')}`);
	}
	const userIds = [...found.values()].map((user) => user.id);
	const memberships = await executor
		.selectDistinct({ companyId: companyMembers.companyId })
		.from(companyMembers)
		.innerJoin(companies, eq(companies.id, companyMembers.companyId))
		.where(
			and(inArray(companyMembers.userId, userIds), eq(companyMembers.status, 'active'), isNull(companies.demoSessionId))
		);
	const profiles = await executor
		.select({ id: candidates.id })
		.from(candidates)
		.where(and(inArray(candidates.userId, userIds), isNull(candidates.demoSessionId)));
	return {
		batch,
		users: found,
		companyIds: memberships.map((row) => row.companyId),
		candidateIds: profiles.map((row) => row.id)
	};
}

/**
 * Marks the profiles and companies of the originals: a visitor inside a demo session acts with their clones, and the
 * originals are not shown there (domain 19.3). Marking again changes nothing.
 */
export async function markCastOriginals(executor: Executor, originals: CastOriginals): Promise<void> {
	if (originals.candidateIds.length > 0) {
		await executor.update(candidates).set({ demoOriginal: true }).where(inArray(candidates.id, originals.candidateIds));
	}
	if (originals.companyIds.length > 0) {
		await executor.update(companies).set({ demoOriginal: true }).where(inArray(companies.id, originals.companyIds));
	}
}

/** The address of a role's clone in a demo session: the original's address with a tag of the session. */
export function cloneEmail(original: string, sessionId: string): string {
	const at = original.lastIndexOf('@');
	return `${original.slice(0, at)}+demo-${sessionId.slice(-12)}${original.slice(at)}`;
}
