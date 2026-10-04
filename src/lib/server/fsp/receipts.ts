// Verification receipts of FSP facts and of the facts of verified public profiles (docs/domain.md, sections 9.4, 9.6): a statement about one version of a fact,
// signed with Ed25519 by the platform key `RECEIPT_ACTIVE_SIGNING_KEY`. References that are the same for every
// audience (`source_record_ref`, the snapshot hash) enter the statement as salted commitments, so receipts of one
// candidate given to different companies cannot be linked by comparing them. The status of a receipt is computed at
// the moment of the check from the fact it speaks of and is never stored.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '$lib/server/config';
import { base32 } from '$lib/server/crypto/encoding';
import type { Executor, Transaction } from '$lib/server/db';
import { receiptTemplates, sourceFacts, verificationReceipts } from '$lib/server/db/schema';
import type { CodeforcesPayload, GithubPayload } from '$lib/server/external-profiles/facts';
import { canonicalJson } from '$lib/server/json/canonical';
import { receiptLimitsSchema, type ReceiptLimits } from '$lib/server/taxonomy/datasets';
import { latestPublishedVersion } from '$lib/server/taxonomy/vocabulary';
import {
	generalizedAssertions,
	receiptEligible,
	sha256Hex,
	type FactDraft,
	type FactPayload,
	type ReceiptTemplate
} from './projection';

const RECEIPT_VERSION = 1;

/** PKCS #8 DER prefix of an Ed25519 private key; the 32-byte seed follows it (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyOf(seed: Buffer): KeyObject {
	if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
	return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export interface ReceiptSigner {
	/** Public origin of the platform: the issuer named in statements. */
	issuer: string;
	keyId: string;
	/**
	 * The FSP of this platform is the simulator of a demonstration stand, not the federation: the statements of FSP
	 * facts it signs say so (`source_simulator`).
	 */
	fspSimulator: boolean;
	sign(message: string): string;
}

export function createReceiptSigner(input: {
	issuer: string;
	keyId: string;
	seed: Buffer;
	/** The FSP facts come from the simulator; absent — from the federation itself. */
	fspSimulator?: boolean;
}): ReceiptSigner {
	const key = privateKeyOf(input.seed);
	return {
		issuer: input.issuer,
		keyId: input.keyId,
		fspSimulator: input.fspSimulator ?? false,
		sign: (message) => sign(null, Buffer.from(message, 'utf8'), key).toString('base64url')
	};
}

/**
 * The signer of the active key of the configured key ring, issuing in the name of the application origin. The FSP
 * source is the simulator when the achievements source is configured as the simulator (`FSP_ACHIEVEMENTS_ADAPTER=mock`,
 * which a demonstration stand requires): the athletes and results of such a platform are synthetic.
 */
export function configuredReceiptSigner(): ReceiptSigner {
	const settings = config();
	const keyId = settings.crypto.activeReceiptSigningKeyId;
	const seed = settings.crypto.receiptSigningKeys.get(keyId);
	if (!seed) throw new Error('the active receipt signing key is missing from the key ring');
	return createReceiptSigner({
		issuer: settings.appOrigin,
		keyId,
		seed,
		fspSimulator: settings.fspAchievements?.adapter === 'mock'
	});
}

// --- Public keys ------------------------------------------------------------------------------------------------

export interface ReceiptJwk {
	kty: 'OKP';
	crv: 'Ed25519';
	/** The public key, base64url (RFC 8037). */
	x: string;
	kid: string;
	use: 'sig';
	alg: 'EdDSA';
}

/** Public keys of the key ring as a JWKS (`/.well-known/receipt-keys.json`); retired keys stay to check old receipts. */
export function receiptKeySet(keys: ReadonlyMap<string, Buffer>): { keys: ReceiptJwk[] } {
	return {
		keys: [...keys]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([kid, seed]) => {
				const jwk = createPublicKey(privateKeyOf(seed)).export({ format: 'jwk' });
				if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
					throw new Error(`receipt key ${kid} is not an Ed25519 key`);
				}
				return { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, use: 'sig', alg: 'EdDSA' };
			})
	};
}

/**
 * Checks the signature of a statement with a public key of the set: `unknown_key` — the set has no key with that id.
 * The signed message is the canonical JSON of the statement, so a statement read back from jsonb verifies as issued.
 */
export function checkReceiptSignature(
	statement: unknown,
	signature: string,
	signingKeyId: string,
	keySet: { keys: readonly ReceiptJwk[] }
): 'valid' | 'invalid' | 'unknown_key' {
	const jwk = keySet.keys.find((key) => key.kid === signingKeyId);
	if (!jwk) return 'unknown_key';
	const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
	const valid = verify(null, Buffer.from(canonicalJson(statement), 'utf8'), key, Buffer.from(signature, 'base64url'));
	return valid ? 'valid' : 'invalid';
}

// --- Statements -------------------------------------------------------------------------------------------------

/** SHA-256 of `value ‖ nonce` in hex. */
function commitment(value: string, nonce: Buffer): string {
	return createHash('sha256').update(value, 'utf8').update(nonce).digest('hex');
}

type Level = 'generalized' | 'exact';
type Assertions = Record<string, string | number>;

/**
 * Values an exact receipt may assert (receipt templates, `exact`). `null` — the source has no such value, and the
 * receipt does not assert it.
 */
export function exactAssertions(fact: FactPayload): Record<string, string | number | null> {
	switch (fact.factType) {
		case 'competition_result': {
			const { result, competition } = fact.payload;
			return {
				discipline: competition.discipline,
				competition: competition.title,
				competitionLevel: competition.level,
				season: Number(competition.startDate.slice(0, 4)),
				stage: competition.stage ?? null,
				place: result.place,
				format: competition.online === undefined ? 'unknown' : competition.online ? 'online' : 'onsite'
			};
		}
		case 'qualification': {
			const { qualification } = fact.payload;
			return {
				discipline: qualification.discipline ?? 'unknown',
				rank: qualification.rank,
				assignedOn: qualification.assignedAt,
				orderNumber: qualification.orderNumber ?? null
			};
		}
		case 'national_team': {
			const { nationalTeam } = fact.payload;
			return { discipline: nationalTeam.discipline, season: nationalTeam.season, squad: nationalTeam.squad };
		}
		case 'platform_rating': {
			const { account } = fact.payload;
			return { platform: account.platform, login: account.login, rating: account.rating ?? null };
		}
	}
}

/** A fact of a verified public profile as a receipt speaks of it (src/lib/server/external-profiles/facts.ts). */
export type ProfileReceiptPayload =
	| { source: 'codeforces'; factType: 'platform_rating'; payload: CodeforcesPayload }
	| { source: 'github'; factType: 'repo_languages'; payload: GithubPayload };

/** What a receipt speaks of: an FSP fact or a fact of a public profile. */
type ReceiptPayload = ({ source: 'fsp' } & FactPayload) | ProfileReceiptPayload;

/** Title band of a Codeforces peak rating, so that a generalized receipt does not state the exact rating. */
function codeforcesBand(rating: number | null): string {
	if (rating === null) return 'unrated';
	const bands: [number, string][] = [
		[3000, 'legendary_grandmaster'],
		[2600, 'international_grandmaster'],
		[2400, 'grandmaster'],
		[2300, 'international_master'],
		[2100, 'master'],
		[1900, 'candidate_master'],
		[1600, 'expert'],
		[1400, 'specialist'],
		[1200, 'pupil']
	];
	return bands.find(([from]) => rating >= from)?.[1] ?? 'newbie';
}

/** Values a receipt of a public profile fact may assert at a level; `null` — the source has no such value. */
function profileAssertions(fact: ProfileReceiptPayload, level: Level): Record<string, string | number | null> {
	if (fact.source === 'codeforces') {
		const { account, maxRating } = fact.payload;
		const peak = maxRating ?? account.rating;
		return level === 'generalized'
			? { platform: 'codeforces', ratingBand: codeforcesBand(peak) }
			: { platform: 'codeforces', handle: account.login, rating: account.rating, maxRating };
	}
	const { languages, ownRepos } = fact.payload;
	return level === 'generalized'
		? { languages: languages.map((l) => l.name).join(', ') }
		: {
				languages: languages.map((l) => `${l.name} ${String(Math.round(l.share * 100))}%`).join(', '),
				repositories: ownRepos
			};
}

function assertionsOf(fact: ReceiptPayload, fields: readonly string[], level: Level): Assertions {
	let values: Record<string, string | number | null>;
	if (fact.source === 'fsp') values = level === 'generalized' ? generalizedAssertions(fact) : exactAssertions(fact);
	else values = profileAssertions(fact, level);
	const asserts: Assertions = {};
	for (const field of fields) {
		const value = values[field];
		if (value === undefined) {
			throw new Error(
				`receipt template asserts ${field} at ${level}, which a ${fact.source} ${fact.factType} fact lacks`
			);
		}
		if (value !== null) asserts[field] = value;
	}
	return asserts;
}

/**
 * What the receipt of the fact does not assert, from the template: its texts for every receipt, then for a team or a
 * personal competition result, then for the role in the team («unknown» when the source did not pass it). A personal
 * result is not said to leave a contribution to a team solution unconfirmed.
 */
export function doesNotAssertOf(fact: ReceiptPayload, limits: ReceiptLimits): string[] {
	if (fact.source !== 'fsp' || fact.factType !== 'competition_result') return [...limits.all];
	const { team } = fact.payload.result;
	if (!team) return [...limits.individual, ...limits.all];
	return [...limits.team, ...(limits.byRole[team.role ?? 'unknown'] ?? []), ...limits.all];
}

interface ReceiptFact {
	id: string;
	fact: ReceiptPayload;
	sourceRecordRef: string;
	payloadSha256: string;
	sourceSnapshotSha256: string;
	lastVerifiedAt: Date;
}

function signedStatement(
	signer: ReceiptSigner,
	input: ReceiptFact,
	level: Level,
	asserts: Assertions,
	limits: ReceiptLimits,
	verifiedAt: string
) {
	const nonce = randomBytes(32);
	const statement = {
		receipt_version: RECEIPT_VERSION,
		source: input.fact.source,
		fact_type: input.fact.factType,
		verified_at: verifiedAt,
		asserts,
		does_not_assert: doesNotAssertOf(input.fact, limits),
		// Exact: the company already sees the very competition and place, so the reference itself is stated.
		record_commitment: level === 'exact' ? input.sourceRecordRef : commitment(input.sourceRecordRef, nonce),
		snapshot_commitment: level === 'exact' ? input.sourceSnapshotSha256 : commitment(input.sourceSnapshotSha256, nonce),
		issuer: { platform: signer.issuer, signing_key_id: signer.keyId },
		...(input.fact.source === 'fsp' && signer.fspSimulator ? { source_simulator: true as const } : {})
	};
	const canonical = canonicalJson(statement);
	return {
		// 128 random bits: nothing about the fact, the candidate or the audience can be read from the handle.
		handle: base32(randomBytes(16)),
		factId: input.id,
		factPayloadSha256: input.payloadSha256,
		disclosureLevel: level,
		statement,
		statementSha256: sha256Hex(canonical),
		signature: signer.sign(canonical),
		signingKeyId: signer.keyId,
		commitmentNonce: nonce,
		issuedAt: new Date()
	};
}

type SelfReceiptInput = Omit<ReceiptFact, 'fact'>;

async function issueOwnReceipt(
	tx: Transaction,
	signer: ReceiptSigner,
	template: ReceiptTemplate,
	input: ReceiptFact
): Promise<'issued' | 'exists'> {
	const [existing] = await tx
		.select({ id: verificationReceipts.id })
		.from(verificationReceipts)
		.where(
			and(
				eq(verificationReceipts.factId, input.id),
				eq(verificationReceipts.factPayloadSha256, input.payloadSha256),
				isNull(verificationReceipts.audienceCompanyId),
				eq(verificationReceipts.disclosureLevel, 'generalized')
			)
		);
	if (existing) return 'exists';
	const asserts = assertionsOf(input.fact, template.generalized, 'generalized');
	const receipt = signedStatement(
		signer,
		input,
		'generalized',
		asserts,
		template.doesNotAssert,
		input.lastVerifiedAt.toISOString()
	);
	await tx.insert(verificationReceipts).values({ ...receipt, audienceCompanyId: null });
	return 'issued';
}

/**
 * Issues the candidate's own generalized receipt of a fact version (`audience_company_id = NULL`) unless it exists:
 * one receipt per fact version, audience and level (the unique key of the table).
 */
export async function issueSelfReceipt(
	tx: Transaction,
	signer: ReceiptSigner,
	template: ReceiptTemplate,
	input: SelfReceiptInput & { fact: FactPayload }
): Promise<'issued' | 'exists'> {
	return issueOwnReceipt(tx, signer, template, { ...input, fact: { source: 'fsp', ...input.fact } });
}

/** The candidate's own generalized receipt of a fact of a verified public profile, as `issueSelfReceipt`. */
export async function issueProfileSelfReceipt(
	tx: Transaction,
	signer: ReceiptSigner,
	template: ReceiptTemplate,
	input: SelfReceiptInput & { fact: ProfileReceiptPayload }
): Promise<'issued' | 'exists'> {
	return issueOwnReceipt(tx, signer, template, input);
}

// --- Receipts for a company -------------------------------------------------------------------------------------

export interface LeveledReceiptTemplate {
	generalized: readonly string[];
	exact: readonly string[];
	doesNotAssert: ReceiptLimits;
}

const templateAssertsSchema = z.object({ generalized: z.array(z.string()), exact: z.array(z.string()) });

/** Key of a receipt template: the same fact type of two sources has two templates. */
export const templateKey = (source: string, factType: string) => `${source}/${factType}`;

/** Receipt templates of the latest published taxonomy version, by `templateKey`. */
export async function loadReceiptTemplates(executor: Executor): Promise<Map<string, LeveledReceiptTemplate>> {
	const version = await latestPublishedVersion(executor);
	if (!version) return new Map();
	const rows = await executor.select().from(receiptTemplates).where(eq(receiptTemplates.taxonomyVersionId, version.id));
	return new Map(
		rows.map((row) => {
			const asserts = templateAssertsSchema.parse(row.asserts);
			return [
				templateKey(row.source, row.factType),
				{ ...asserts, doesNotAssert: receiptLimitsSchema.parse(row.doesNotAssert) }
			];
		})
	);
}

export interface CompanyReceiptsRequest {
	companyId: string;
	candidateId: string;
	/** Facts the company's card shows. */
	factIds: readonly string[];
	/** Of them, the facts the card shows exactly (the candidate disclosed exact achievements to the catalog). */
	exactFactIds: readonly string[];
}

export interface CompanyReceiptsOutcome {
	issued: number;
	existing: number;
	/** Facts that do not qualify for a receipt now: withdrawn, annulled, superseded, preliminary or without template. */
	ineligible: number;
}

/**
 * What a receipt of an active fact speaks of, or `null` when the fact does not qualify: an FSP fact that is not
 * confirmed enough (preliminary, unplaced), a public profile fact whose ownership is not verified, any other source.
 */
function receiptPayloadOf(row: typeof sourceFacts.$inferSelect): ReceiptPayload | null {
	if (row.source === 'fsp') {
		if (row.eventKey === null) throw new Error(`FSP fact ${row.id} has no event key`);
		const payload = { factType: row.factType, payload: row.payload } as FactPayload;
		const draft: FactDraft = {
			...payload,
			sourceRecordRef: row.sourceRecordRef,
			eventKey: row.eventKey,
			payloadSha256: row.payloadSha256,
			occurredOn: row.occurredOn,
			status: 'active'
		};
		return receiptEligible(draft) ? { source: 'fsp', ...payload } : null;
	}
	if (row.trustLevel !== 'public_verifiable') return null;
	if (row.source === 'codeforces' && row.factType === 'platform_rating') {
		return { source: 'codeforces', factType: 'platform_rating', payload: row.payload as CodeforcesPayload };
	}
	if (row.source === 'github' && row.factType === 'repo_languages') {
		return { source: 'github', factType: 'repo_languages', payload: row.payload as GithubPayload };
	}
	return null;
}

/**
 * Receipts of the facts a company is shown, issued for that company at the level the card shows each fact: exact for
 * a fact shown exactly, generalized for the rest — one receipt per shown fact, never both levels of one achievement
 * side by side. Each receipt has its own handle and its own salt, so the receipts of two
 * companies about one fact share no identifier and no commitment. Repeated views return the receipts already issued
 * for the same fact version (the unique key of the table).
 */
export async function issueCompanyReceipts(
	executor: Executor,
	signer: ReceiptSigner,
	templates: ReadonlyMap<string, LeveledReceiptTemplate>,
	request: CompanyReceiptsRequest
): Promise<CompanyReceiptsOutcome> {
	const outcome: CompanyReceiptsOutcome = { issued: 0, existing: 0, ineligible: 0 };
	const factIds = [...new Set(request.factIds)];
	const exact = new Set(request.exactFactIds);
	for (const id of exact) {
		if (!factIds.includes(id)) throw new Error(`fact ${id} is shown exactly but is not among the shown facts`);
	}
	if (factIds.length === 0) return outcome;
	const rows = await executor
		.select()
		.from(sourceFacts)
		.where(and(inArray(sourceFacts.id, factIds), eq(sourceFacts.candidateId, request.candidateId)));
	if (rows.length !== factIds.length) throw new Error('a shown fact does not belong to the candidate');

	for (const row of rows) {
		const template = templates.get(templateKey(row.source, row.factType));
		const fact = template && row.status === 'active' ? receiptPayloadOf(row) : null;
		if (!template || fact === null) {
			outcome.ineligible++;
			continue;
		}
		if (row.sourceSnapshotSha256 === null) throw new Error(`fact ${row.id} has no snapshot hash`);
		const input: ReceiptFact = {
			id: row.id,
			fact,
			sourceRecordRef: row.sourceRecordRef,
			payloadSha256: row.payloadSha256,
			sourceSnapshotSha256: row.sourceSnapshotSha256,
			lastVerifiedAt: row.lastVerifiedAt
		};
		const level: Level = exact.has(row.id) ? 'exact' : 'generalized';
		const receipt = signedStatement(
			signer,
			input,
			level,
			assertionsOf(fact, template[level], level),
			template.doesNotAssert,
			// To the day: an exact instant shared by the receipts of all companies would identify the candidate.
			row.lastVerifiedAt.toISOString().slice(0, 10)
		);
		const inserted = await executor
			.insert(verificationReceipts)
			.values({ ...receipt, audienceCompanyId: request.companyId })
			.onConflictDoNothing({
				target: [
					verificationReceipts.factId,
					verificationReceipts.factPayloadSha256,
					verificationReceipts.audienceCompanyId,
					verificationReceipts.disclosureLevel
				]
			})
			.returning({ id: verificationReceipts.id });
		if (inserted.length > 0) outcome.issued++;
		else outcome.existing++;
	}
	return outcome;
}

// --- Verification -----------------------------------------------------------------------------------------------

/** The statement as signed; members of later receipt versions are kept as they are. */
export const receiptStatementSchema = z
	.object({
		receipt_version: z.int(),
		source: z.string(),
		fact_type: z.string(),
		verified_at: z.string().describe('Дата сверки с источником'),
		asserts: z.record(z.string(), z.union([z.string(), z.number()])).describe('Что факт подтверждает'),
		does_not_assert: z.array(z.string()).describe('Чего факт не подтверждает'),
		record_commitment: z.string().describe('Обязательство на запись источника с солью, а не сама запись'),
		snapshot_commitment: z.string(),
		issuer: z.object({ platform: z.string(), signing_key_id: z.string() }),
		source_simulator: z
			.literal(true)
			.optional()
			.describe(
				'Источник — демонстрационный имитатор ФСП, а не сама федерация: спортсмен и результаты синтетические. ' +
					'Есть только в квитанциях демонстрационного стенда'
			)
	})
	.catchall(z.unknown())
	.describe('Заявление, как оно подписано');

export type ReceiptStatement = z.output<typeof receiptStatementSchema>;

export type ReceiptStatus = 'valid' | 'superseded' | 'annulled' | 'not_valid';

type FactStatus = (typeof sourceFacts.$inferSelect)['status'];

/**
 * `valid` — the fact is active at the version the receipt speaks of; `superseded` — the source sent a new version of
 * the record; `annulled` — the source annulled it; `not_valid` — withdrawn (consent revoked, link removed, deleted).
 */
export function receiptStatus(factStatus: FactStatus, sameVersion: boolean): ReceiptStatus {
	switch (factStatus) {
		case 'active':
			return sameVersion ? 'valid' : 'superseded';
		case 'superseded':
			return 'superseded';
		case 'annulled':
			return 'annulled';
		case 'withdrawn':
			return 'not_valid';
	}
}

/** The statement says its source is the simulator of a demonstration stand. */
export const fromSimulator = (statement: ReceiptStatement): boolean => statement.source_simulator === true;

export interface VerifiedReceipt {
	status: ReceiptStatus;
	disclosureLevel: Level;
	statement: unknown;
	signature: string;
	signingKeyId: string;
}

/**
 * A receipt by its public handle with its status now; `null` — no such receipt (never issued, or deleted with the
 * account). Nothing about the person is read: no candidate id, pseudonym or personal data.
 */
export async function verifyReceipt(executor: Executor, handle: string): Promise<VerifiedReceipt | null> {
	const [row] = await executor
		.select({
			statement: verificationReceipts.statement,
			signature: verificationReceipts.signature,
			signingKeyId: verificationReceipts.signingKeyId,
			disclosureLevel: verificationReceipts.disclosureLevel,
			receiptPayloadSha256: verificationReceipts.factPayloadSha256,
			factStatus: sourceFacts.status,
			factPayloadSha256: sourceFacts.payloadSha256
		})
		.from(verificationReceipts)
		.innerJoin(sourceFacts, eq(sourceFacts.id, verificationReceipts.factId))
		.where(eq(verificationReceipts.handle, handle));
	if (!row) return null;
	return {
		status: receiptStatus(row.factStatus, row.factPayloadSha256 === row.receiptPayloadSha256),
		disclosureLevel: row.disclosureLevel,
		statement: row.statement,
		signature: row.signature,
		signingKeyId: row.signingKeyId
	};
}
