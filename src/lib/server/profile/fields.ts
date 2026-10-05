// The candidate's own profile fields (docs/domain.md, section 7.1): the name, the phone and Telegram, a headline and the
// soft skills, typed by hand or accepted from the suggestions of the resume. The name and the contacts are personal
// data, encrypted in their columns; the journal names the changed fields, never their values. Nothing here is
// evidence: matching, categories and the catalog card do not read these fields, so a change moves no revision; the
// company sees the name and the phone only through a disclosure (invitations/disclosure.ts), and the PDF profile shows
// what the candidate hands over themselves.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { FieldContext, FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import { candidates, profileSuggestions, users } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { selfCandidate } from '$lib/server/resumes/deps';
import { namePart, normalizeEmail, normalizePhone, normalizeTelegram, type FullName } from './contacts';
import { isSoftSkillKey, MAX_SOFT_SKILLS } from './soft-skills';

export interface ProfileDeps {
	db: Database;
	crypto: FieldCrypto;
	now: () => Date;
}

/** Longest headline: the position the candidate is after, in a line. */
export const HEADLINE_MAX = 200;

export interface OwnProfile {
	fullName: FullName | null;
	phone: string | null;
	telegram: string | null;
	/** The address of the account: the contact e-mail of the profile, changed in the account settings. */
	email: string;
	headline: string | null;
	softSkillKeys: string[];
	desiredRoleKeys: string[];
}

function open(crypto: FieldCrypto, value: Uint8Array | null, context: FieldContext): string | null {
	return value === null ? null : crypto.decrypt(value, context);
}

/** The candidate's own fields, decrypted for the candidate. */
export async function readOwnProfile(
	executor: Executor,
	crypto: FieldCrypto,
	candidateId: string
): Promise<OwnProfile> {
	const [row] = await executor
		.select({
			lastNameEnc: candidates.lastNameEnc,
			firstNameEnc: candidates.firstNameEnc,
			middleNameEnc: candidates.middleNameEnc,
			phoneEnc: candidates.phoneEnc,
			telegramEnc: candidates.telegramEnc,
			headline: candidates.headline,
			softSkillKeys: candidates.softSkillKeys,
			desiredRoleKeys: candidates.desiredRoleKeys,
			emailEnc: users.emailEnc
		})
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(candidates.id, candidateId));
	if (!row) throw new ApiError('not_found');
	const last = open(crypto, row.lastNameEnc, 'candidates.last_name');
	const first = open(crypto, row.firstNameEnc, 'candidates.first_name');
	const email = open(crypto, row.emailEnc, 'users.email');
	if (email === null) throw new Error(`the account of candidate ${candidateId} has no address`);
	return {
		fullName:
			last === null || first === null
				? null
				: { last, first, middle: open(crypto, row.middleNameEnc, 'candidates.middle_name') },
		phone: open(crypto, row.phoneEnc, 'candidates.phone'),
		telegram: open(crypto, row.telegramEnc, 'candidates.telegram'),
		email,
		headline: row.headline,
		softSkillKeys: row.softSkillKeys,
		desiredRoleKeys: row.desiredRoleKeys
	};
}

/** What the form and `PUT /api/v1/me/profile` send: every field, an empty one clears it. */
export const profileInputSchema = z.strictObject({
	last_name: z.string().max(200).nullable().describe('Фамилия; вместе с именем или пусто'),
	first_name: z.string().max(200).nullable().describe('Имя; вместе с фамилией или пусто'),
	middle_name: z.string().max(200).nullable().describe('Отчество, если есть'),
	phone: z.string().max(40).nullable().describe('Телефон: +7XXXXXXXXXX, 8XXXXXXXXXX или международный с +'),
	telegram: z.string().max(64).nullable().describe('Telegram: @name или t.me/name'),
	headline: z.string().max(HEADLINE_MAX).nullable().describe('Желаемая должность одной строкой'),
	soft_skill_keys: z.array(z.string()).max(MAX_SOFT_SKILLS).describe('Мягкие навыки — ключи справочника')
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

interface NormalizedProfile {
	fullName: FullName | null;
	phone: string | null;
	telegram: string | null;
	headline: string | null;
	softSkillKeys: string[];
}

const blank = (value: string | null): boolean => value === null || value.trim() === '';

/** The input in its stored form, or every problem of it with the field it is about. */
export function normalizeProfileInput(input: ProfileInput): NormalizedProfile {
	const problems: ErrorDetail[] = [];
	const part = (path: string, value: string | null): string | null => {
		if (blank(value) || value === null) return null;
		const normalized = namePart(value);
		if (normalized === null) problems.push({ path, code: 'invalid_name', message: 'Только буквы, пробел и дефис' });
		return normalized;
	};
	const last = part('last_name', input.last_name);
	const first = part('first_name', input.first_name);
	const middle = part('middle_name', input.middle_name);
	if (
		(last === null) !== (first === null) &&
		!problems.some((p) => p.path === 'last_name' || p.path === 'first_name')
	) {
		const path = last === null ? 'last_name' : 'first_name';
		problems.push({ path, code: 'required_with_name', message: 'Фамилия и имя указываются вместе' });
	}
	if (middle !== null && last === null && first === null && !problems.some((p) => p.path === 'middle_name')) {
		problems.push({
			path: 'middle_name',
			code: 'required_with_name',
			message: 'Отчество — вместе с фамилией и именем'
		});
	}
	const contact = (path: string, value: string | null, normalize: (written: string) => string | null, hint: string) => {
		if (blank(value) || value === null) return null;
		const normalized = normalize(value);
		if (normalized === null) problems.push({ path, code: 'invalid_format', message: hint });
		return normalized;
	};
	const phone = contact('phone', input.phone, normalizePhone, 'Телефон в виде +7 912 345-67-89');
	const telegram = contact('telegram', input.telegram, normalizeTelegram, 'Имя в Telegram: @name, от 5 символов');
	const headline = blank(input.headline) || input.headline === null ? null : input.headline.trim();
	const softSkillKeys = [...new Set(input.soft_skill_keys)];
	if (softSkillKeys.some((key) => !isSoftSkillKey(key))) {
		problems.push({ path: 'soft_skill_keys', code: 'unknown', message: 'Такого навыка нет в списке' });
	}
	if (problems.length > 0) throw new ApiError('validation_failed', { details: problems });
	return {
		fullName: last === null || first === null ? null : { last, first, middle },
		phone,
		telegram,
		headline,
		softSkillKeys
	};
}

const seal = (crypto: FieldCrypto, value: string | null, context: FieldContext) =>
	value === null ? null : crypto.encrypt(value, context);

/** The names of the fields that differ between two states of the profile. */
function changedFields(before: OwnProfile, after: NormalizedProfile): string[] {
	const changed: string[] = [];
	const name = (value: FullName | null) => (value === null ? null : JSON.stringify(value));
	if (name(before.fullName) !== name(after.fullName)) changed.push('full_name');
	if (before.phone !== after.phone) changed.push('phone');
	if (before.telegram !== after.telegram) changed.push('telegram');
	if (before.headline !== after.headline) changed.push('headline');
	if (before.softSkillKeys.join() !== after.softSkillKeys.join()) changed.push('soft_skills');
	return changed;
}

async function writeProfile(
	deps: ProfileDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	candidateId: string,
	next: (current: OwnProfile) => NormalizedProfile,
	tx: Executor
): Promise<string[]> {
	const current = await readOwnProfile(tx, deps.crypto, candidateId);
	const after = next(current);
	const fields = changedFields(current, after);
	if (fields.length === 0) return fields;
	await tx
		.update(candidates)
		.set({
			lastNameEnc: seal(deps.crypto, after.fullName?.last ?? null, 'candidates.last_name'),
			firstNameEnc: seal(deps.crypto, after.fullName?.first ?? null, 'candidates.first_name'),
			middleNameEnc: seal(deps.crypto, after.fullName?.middle ?? null, 'candidates.middle_name'),
			phoneEnc: seal(deps.crypto, after.phone, 'candidates.phone'),
			telegramEnc: seal(deps.crypto, after.telegram, 'candidates.telegram'),
			headline: after.headline,
			softSkillKeys: after.softSkillKeys
		})
		.where(eq(candidates.id, candidateId));
	await recordAuditEvent(tx, {
		action: 'profile.updated',
		outcome: 'success',
		actor: auditActor(subject, meta, 'candidate'),
		object: { type: 'candidate', id: candidateId },
		subjectCandidateId: candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		details: { fields },
		occurredAt: deps.now()
	});
	return fields;
}

/** The candidate saves the form: every field as sent. Returns the names of the changed fields. */
export async function updateOwnProfile(
	deps: ProfileDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: ProfileInput
): Promise<string[]> {
	const { candidateId } = selfCandidate(subject);
	const normalized = normalizeProfileInput(input);
	return deps.db.transaction(async (tx) => {
		await lockProfile(tx, candidateId);
		await requireProcessingConsent(tx, candidateId, deps.now());
		return writeProfile(deps, subject, meta, candidateId, () => normalized, tx);
	});
}

async function lockProfile(tx: Executor, candidateId: string): Promise<void> {
	const [row] = await tx
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (!row) throw new ApiError('not_found');
}

/**
 * The candidate decides on a suggestion of the resume. Accepting writes its value into its field — the name replaces
 * the name, a contact the contact, a soft skill joins the list — exactly as typing it would; rejecting records the
 * decision only. A suggestion already decided, of another candidate or of a reading that is no longer current is `404`
 * or `409`.
 */
export async function decideSuggestion(
	deps: ProfileDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	suggestionId: string,
	decision: 'accepted' | 'rejected'
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	await deps.db.transaction(async (tx) => {
		await lockProfile(tx, candidateId);
		const [row] = await tx
			.select()
			.from(profileSuggestions)
			.where(and(eq(profileSuggestions.id, suggestionId), eq(profileSuggestions.candidateId, candidateId)))
			.for('update');
		if (!row) throw new ApiError('not_found');
		if (row.status !== 'pending') {
			throw new ApiError('conflict', {
				message: 'Решение по этому полю уже принято',
				details: [{ code: 'suggestion_decided', message: row.status }]
			});
		}
		if (decision === 'accepted') {
			await requireProcessingConsent(tx, candidateId, deps.now());
			const value =
				row.field === 'soft_skill' ? row.skillKey : open(deps.crypto, row.valueEnc, 'profile_suggestions.value');
			if (value === null) throw new Error(`suggestion ${row.id} has no value`);
			await writeProfile(deps, subject, meta, candidateId, (current) => applySuggestion(current, row.field, value), tx);
		}
		await tx
			.update(profileSuggestions)
			.set({ status: decision, decidedAt: deps.now() })
			.where(eq(profileSuggestions.id, row.id));
		await recordAuditEvent(tx, {
			action: 'profile.suggestion_decided',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'profile_suggestion', id: row.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { field: row.field, decision },
			occurredAt: deps.now()
		});
	});
}

const nameSchema = z.strictObject({ last: z.string(), first: z.string(), middle: z.string().nullable() });

/** The profile with the suggested value in its field. */
function applySuggestion(
	current: OwnProfile,
	field: (typeof profileSuggestions.$inferSelect)['field'],
	value: string
): NormalizedProfile {
	const base: NormalizedProfile = {
		fullName: current.fullName,
		phone: current.phone,
		telegram: current.telegram,
		headline: current.headline,
		softSkillKeys: current.softSkillKeys
	};
	switch (field) {
		case 'full_name':
			return { ...base, fullName: nameSchema.parse(JSON.parse(value)) };
		case 'phone':
			return { ...base, phone: value };
		case 'telegram':
			return { ...base, telegram: value };
		case 'email':
			// The contact e-mail is the account's: the suggestion is shown to compare, accepting it changes nothing here.
			throw new ApiError('conflict', {
				message: 'Почта профиля — это почта входа: она меняется в настройках аккаунта',
				details: [{ code: 'email_is_account', message: normalizeEmail(value) ?? value }]
			});
		case 'soft_skill': {
			if (base.softSkillKeys.includes(value)) return base;
			if (base.softSkillKeys.length >= MAX_SOFT_SKILLS) {
				throw new ApiError('conflict', {
					message: `В профиле уже ${MAX_SOFT_SKILLS} мягких навыков: уберите один, чтобы добавить этот`,
					details: [{ code: 'soft_skills_full', message: String(MAX_SOFT_SKILLS) }]
				});
			}
			return { ...base, softSkillKeys: [...base.softSkillKeys, value] };
		}
	}
}
