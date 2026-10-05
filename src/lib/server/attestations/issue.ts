// Issuing the confirmations of a candidate's categories (docs/domain.md, section 12.9) when the PDF profile is made:
// one confirmation per assignment of a category in force, signed with Ed25519 by the key of the receipts (domain 9.6).
// A repeated PDF of the same assignment gives the same confirmation; a new assignment (the next grade, a returned
// category after an annulment) is a new row of `candidate_categories` and so a new confirmation, while the old one
// answers `superseded` or `annulled` at its check.
import { createHash, randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { decisionJudgement } from '$lib/server/assessments/views';
import { activeCategories, type ActiveCategory } from '$lib/server/categories/read';
import { base32 } from '$lib/server/crypto/encoding';
import type { Executor, Transaction } from '$lib/server/db';
import { categoryAttestations } from '$lib/server/db/schema';
import type { ReceiptSigner } from '$lib/server/fsp/receipts';
import { canonicalJson } from '$lib/server/json/canonical';
import type { FullName } from '$lib/server/profile/contacts';
import { attestationStatementSchema, categoryStatement, commitmentOfName } from './statement';

const noteOf = (statement: unknown): string | null => attestationStatementSchema.parse(statement).judgement.note;

export interface IssuedAttestation {
	handle: string;
	category: ActiveCategory;
	/** The salt of the holder commitment in base32: the candidate gives it to whom they prove the confirmation is theirs. */
	holderCode: string;
	/** `true` — issued now; `false` — the confirmation of this assignment existed. */
	issued: boolean;
	/** The note on how the clusters of the attempt were judged, as the statement says it; `null` — signed by people. */
	judgementNote: string | null;
}

/**
 * The confirmations of every category in force of the candidate, issuing the missing ones. The holder commitment is
 * made with the name the profile has now; it needs a name, so the caller refuses a profile without one.
 */
export async function ensureAttestations(
	tx: Transaction,
	signer: ReceiptSigner,
	input: { candidateId: string; holder: FullName; now: Date }
): Promise<IssuedAttestation[]> {
	const categories = (await activeCategories(tx, [input.candidateId])).get(input.candidateId) ?? [];
	if (categories.length === 0) return [];
	const existing = await tx
		.select({
			categoryId: categoryAttestations.categoryId,
			handle: categoryAttestations.handle,
			holderNonce: categoryAttestations.holderNonce,
			statement: categoryAttestations.statement
		})
		.from(categoryAttestations)
		.where(
			inArray(
				categoryAttestations.categoryId,
				categories.map((category) => category.id)
			)
		);
	const byCategory = new Map(existing.map((row) => [row.categoryId, row]));
	const result: IssuedAttestation[] = [];
	for (const category of categories) {
		const found = byCategory.get(category.id);
		if (found) {
			result.push({
				handle: found.handle,
				category,
				holderCode: base32(found.holderNonce),
				issued: false,
				judgementNote: noteOf(found.statement)
			});
			continue;
		}
		const nonce = randomBytes(32);
		const statement = categoryStatement(category, {
			holderCommitment: commitmentOfName(input.holder, nonce),
			issuer: signer.issuer,
			signingKeyId: signer.keyId,
			issuedAt: input.now,
			judgement: await decisionJudgement(tx, category.decisionId)
		});
		const canonical = canonicalJson(statement);
		const handle = base32(randomBytes(16));
		// A PDF made at the same moment in another request may have issued it first: that confirmation stands.
		const inserted = await tx
			.insert(categoryAttestations)
			.values({
				handle,
				candidateId: input.candidateId,
				categoryId: category.id,
				decisionId: category.decisionId,
				bankReleaseId: category.bankReleaseId,
				statement,
				statementSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
				signature: signer.sign(canonical),
				signingKeyId: signer.keyId,
				holderNonce: nonce,
				issuedAt: input.now
			})
			.onConflictDoNothing({ target: categoryAttestations.categoryId })
			.returning({ handle: categoryAttestations.handle });
		if (inserted.length > 0) {
			result.push({
				handle,
				category,
				holderCode: base32(nonce),
				issued: true,
				judgementNote: statement.judgement.note
			});
			continue;
		}
		const [concurrent] = await tx
			.select({
				handle: categoryAttestations.handle,
				holderNonce: categoryAttestations.holderNonce,
				statement: categoryAttestations.statement
			})
			.from(categoryAttestations)
			.where(eq(categoryAttestations.categoryId, category.id));
		if (!concurrent) throw new Error(`the confirmation of category ${category.id} conflicted and is missing`);
		result.push({
			handle: concurrent.handle,
			category,
			holderCode: base32(concurrent.holderNonce),
			issued: false,
			judgementNote: noteOf(concurrent.statement)
		});
	}
	return result;
}

/** The confirmations the candidate has issued, with their holder codes: what the cabinet shows next to the PDF. */
export async function ownAttestations(
	executor: Executor,
	candidateId: string
): Promise<{ handle: string; categoryId: string; holderCode: string; issuedAt: Date }[]> {
	const rows = await executor
		.select({
			handle: categoryAttestations.handle,
			categoryId: categoryAttestations.categoryId,
			holderNonce: categoryAttestations.holderNonce,
			issuedAt: categoryAttestations.issuedAt
		})
		.from(categoryAttestations)
		.where(eq(categoryAttestations.candidateId, candidateId));
	return rows.map((row) => ({
		handle: row.handle,
		categoryId: row.categoryId,
		holderCode: base32(row.holderNonce),
		issuedAt: row.issuedAt
	}));
}
