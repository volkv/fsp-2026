// Candidates of the demo stand, brought to their profile the way a person does it: the registration row (address,
// birth date, the user agreement, the FSP ID identity of an athlete), then the product's own actions — the consent to
// processing, the work terms, the catalog consent, the confirmed FSP import or the uploaded resume. Facts, claims,
// categories and matches follow from the jobs these actions enqueue. The candidate's name and GitHub handle have no
// screen yet and are written as the rows such a screen would write.
import { and, eq } from 'drizzle-orm';
import { confirmFspAchievements } from '$lib/server/auth/identities';
import { grantProfileConsent } from '$lib/server/auth/onboarding';
import { grantCatalogVisibility } from '$lib/server/candidates/consents';
import { setSearchStatus, updateProfileSettings } from '$lib/server/candidates/settings';
import {
	athleteLinks,
	candidates,
	consentEvents,
	externalIdentities,
	externalProfiles,
	resumeDocuments
} from '$lib/server/db/schema';
import { uploadResume } from '$lib/server/resumes/upload';
import { documentOf, ensureUser, metaOf, sessionOf, subjectOf, type SeedContext } from './accounts';
import type { CandidatePlan } from './generate';
import { takeQuiz } from './quizzes';

export interface SeededCandidate {
	key: string;
	candidateId: string;
	userId: string;
}

async function candidateOf(ctx: SeedContext, userId: string) {
	const [row] = await ctx.services.db
		.select({
			id: candidates.id,
			status: candidates.status,
			searchStatus: candidates.searchStatus,
			desiredRoleKeys: candidates.desiredRoleKeys
		})
		.from(candidates)
		.where(eq(candidates.userId, userId));
	return row ?? null;
}

/**
 * The candidate of a plan in its target state; every step checks what is already done, so a seed that stopped half
 * way continues where it stopped.
 */
export async function ensureCandidate(ctx: SeedContext, plan: CandidatePlan): Promise<SeededCandidate> {
	const { db, crypto, fspIdIssuer } = ctx.services;
	const displayName = `${plan.name.firstName} ${plan.name.lastName}`;
	const userId = await ensureUser(ctx, { email: plan.email, displayName });
	const session = sessionOf(ctx, userId);
	const meta = metaOf(ctx, userId);

	let candidate = await candidateOf(ctx, userId);
	if (!candidate) {
		await db.transaction(async (tx) => {
			await tx.insert(candidates).values({
				userId,
				status: 'onboarding',
				searchStatus: 'active',
				preferences: {},
				birthDate: plan.birthDate,
				birthDatePrecision: 'day',
				birthDateSource: 'self_declared',
				birthDateStatus: 'unverified',
				lastNameEnc: crypto.encrypt(plan.name.lastName, 'candidates.last_name'),
				firstNameEnc: crypto.encrypt(plan.name.firstName, 'candidates.first_name'),
				middleNameEnc:
					plan.name.middleName === null ? null : crypto.encrypt(plan.name.middleName, 'candidates.middle_name'),
				seedBatchId: ctx.batch
			});
			if (plan.athlete) {
				// Signed up with FSP ID: the identity of the athlete's account (contracts 2.3).
				await tx.insert(externalIdentities).values({
					userId,
					issuer: fspIdIssuer,
					subject: plan.athlete.fspId,
					linkedAt: ctx.joinedAt,
					linkMethod: 'signup_via_provider',
					profileClaims: {
						name: displayName,
						given_name: plan.athlete.firstName,
						family_name: plan.athlete.lastName,
						preferred_username: plan.email.split('@')[0] ?? null
					}
				});
			}
		});
		candidate = await candidateOf(ctx, userId);
		if (!candidate) throw new Error(`candidate ${plan.key} was not inserted`);
	}
	const candidateId = candidate.id;

	if (candidate.status === 'onboarding') {
		// Given when the person joined: everything the candidate does on the stand comes after it.
		const consent = await grantProfileConsent(
			{ ...ctx.auth, now: () => ctx.joinedAt },
			meta,
			session,
			documentOf(ctx, 'pd_processing').id
		);
		if (!consent.ok) throw new Error(`candidate ${plan.key}: processing consent refused (${consent.reason})`);
	}

	if (candidate.desiredRoleKeys.length === 0 && plan.desiredRoles.length > 0) {
		await updateProfileSettings(db, await subjectOf(ctx, userId), {
			preferences: plan.preferences,
			desiredRoleKeys: plan.desiredRoles
		});
	}
	if (plan.searchStatus !== candidate.searchStatus) {
		await setSearchStatus(db, await subjectOf(ctx, userId), plan.searchStatus);
	}

	if (plan.github !== null) {
		const [profile] = await db
			.select({ id: externalProfiles.id })
			.from(externalProfiles)
			.where(and(eq(externalProfiles.candidateId, candidateId), eq(externalProfiles.platform, 'github')));
		if (!profile) {
			await db
				.insert(externalProfiles)
				.values({ candidateId, platform: 'github', handle: plan.github, ownershipStatus: 'unverified' });
		}
	}

	// Granted once: a candidate who later revoked the consent (scenes.ts) keeps the decision.
	const [decided] = await db
		.select({ id: consentEvents.id })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'catalog_visibility'),
				eq(consentEvents.signerKind, 'subject')
			)
		)
		.limit(1);
	if (plan.catalogScope !== null && !decided) {
		await grantCatalogVisibility(db, await subjectOf(ctx, userId), meta, {
			documentId: documentOf(ctx, 'catalog_visibility').id,
			scopeFields: plan.catalogScope
		});
	}

	if (plan.athlete) {
		const [link] = await db
			.select({ id: athleteLinks.id })
			.from(athleteLinks)
			.where(and(eq(athleteLinks.userId, userId), eq(athleteLinks.status, 'active')));
		if (!link) {
			const linked = await confirmFspAchievements(ctx.auth, meta, session, {
				issuer: fspIdIssuer,
				documentId: documentOf(ctx, 'fsp_import').id
			});
			if (!linked.ok) throw new Error(`candidate ${plan.key}: the FSP import was refused (${linked.reason})`);
		}
	}

	if (plan.resume !== null) {
		const [resume] = await db
			.select({ id: resumeDocuments.id })
			.from(resumeDocuments)
			.where(eq(resumeDocuments.candidateId, candidateId))
			.limit(1);
		if (!resume) {
			await uploadResume(
				{ db, store: ctx.services.store, now: ctx.now },
				await subjectOf(ctx, userId),
				{ bytes: plan.resume.bytes, declaredName: plan.resume.declaredName },
				meta
			);
		}
	}

	const seeded = { key: plan.key, candidateId, userId };
	if (plan.quiz !== null) await takeQuiz(ctx, seeded, plan.quiz);
	return seeded;
}

/** Runs `task` over `items` with at most `limit` at a time, keeping the order of the results. */
export async function inPool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lane = async () => {
		for (let index = next++; index < items.length; index = next++) {
			results[index] = await task(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return results;
}
