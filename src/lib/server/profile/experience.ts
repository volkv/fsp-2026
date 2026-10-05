// Experience the candidate states by hand (docs/domain.md, section 7.1): places of work with the role, the period to
// the month and the stack, for a candidate without a resume or for what the resume leaves out. They are the
// candidate's own word, shown as stated in the profile and the PDF profile; they are not evidence — the grade hint, the
// category and matching rest on the resume and the tests — so a change moves no revision.
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { currentCandidateVocabulary } from '$lib/server/candidates/vocabulary';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { PROFILE_TEXT_LIMITS, profileExperienceEntries } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { selfCandidate } from '$lib/server/resumes/deps';

/** Most entries a profile holds by hand. */
export const MAX_EXPERIENCE_ENTRIES = 20;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export const experienceInputSchema = z.strictObject({
	position_title: z.string().trim().min(1).max(PROFILE_TEXT_LIMITS.title).describe('Должность'),
	organization_name: z.string().trim().max(PROFILE_TEXT_LIMITS.organization).nullable().describe('Компания'),
	role_key: z.string().nullable().describe('Роль из справочника'),
	period_from: z.string().regex(MONTH).describe('Начало: YYYY-MM'),
	period_to: z.string().regex(MONTH).nullable().describe('Окончание: YYYY-MM; `null` — работа продолжается'),
	skill_keys: z.array(z.string()).max(30).describe('Стек — навыки справочника'),
	description: z.string().trim().max(PROFILE_TEXT_LIMITS.description).nullable().describe('Чем занимался')
});

export type ExperienceInput = z.infer<typeof experienceInputSchema>;

export interface ManualExperience {
	id: string;
	positionTitle: string;
	organizationName: string | null;
	roleKey: string | null;
	/** `YYYY-MM`. */
	periodFrom: string;
	periodTo: string | null;
	isCurrent: boolean;
	skillKeys: string[];
	description: string | null;
}

const month = (date: string): string => date.slice(0, 7);

export async function listManualExperience(executor: Executor, candidateId: string): Promise<ManualExperience[]> {
	const rows = await executor
		.select()
		.from(profileExperienceEntries)
		.where(eq(profileExperienceEntries.candidateId, candidateId))
		.orderBy(desc(profileExperienceEntries.periodFrom), desc(profileExperienceEntries.id));
	return rows.map((row) => ({
		id: row.id,
		positionTitle: row.positionTitle,
		organizationName: row.organizationName,
		roleKey: row.roleKey,
		periodFrom: month(row.periodFrom),
		periodTo: row.periodTo === null ? null : month(row.periodTo),
		isCurrent: row.isCurrent,
		skillKeys: row.skillKeys,
		description: row.description
	}));
}

/** The month `YYYY-MM` as a count of months since the year 0. */
function monthIndex(value: string): number {
	const match = MONTH.exec(value);
	if (!match?.[1] || !match[2]) throw new Error(`${value} is not a month`);
	return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/**
 * The length of the stated experience in whole months: the union of the periods, each counted from its first month to
 * its last inclusive (an ongoing job — to the month of `asOf`), so two jobs at once count once.
 */
export function experienceMonths(
	entries: readonly Pick<ManualExperience, 'periodFrom' | 'periodTo'>[],
	asOf: Date
): number {
	const now = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth();
	const spans = entries
		.map((entry) => ({
			from: monthIndex(entry.periodFrom),
			to: entry.periodTo === null ? now : monthIndex(entry.periodTo)
		}))
		.filter((span) => span.from <= span.to)
		.sort((a, b) => a.from - b.from);
	let total = 0;
	let end = -Infinity;
	for (const span of spans) {
		if (span.to <= end) continue;
		total += span.to - Math.max(span.from, end + 1) + 1;
		end = span.to;
	}
	return total;
}

async function normalizeEntry(executor: Executor, input: ExperienceInput, asOf: Date) {
	const vocabulary = await currentCandidateVocabulary(executor);
	if (!vocabulary) throw new ApiError('degraded', { message: 'Справочники ещё не опубликованы' });
	const problems: ErrorDetail[] = [];
	if (input.role_key !== null && !vocabulary.roles.some((role) => role.key === input.role_key)) {
		problems.push({ path: 'role_key', code: 'unknown', message: 'Такой роли нет в справочнике' });
	}
	const skills = [...new Set(input.skill_keys)];
	if (skills.some((key) => !vocabulary.skills.some((skill) => skill.key === key))) {
		problems.push({ path: 'skill_keys', code: 'unknown', message: 'Такого навыка нет в справочнике' });
	}
	const current = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth();
	if (monthIndex(input.period_from) > current) {
		problems.push({ path: 'period_from', code: 'in_future', message: 'Начало работы — не позже текущего месяца' });
	}
	if (input.period_to !== null) {
		if (monthIndex(input.period_to) < monthIndex(input.period_from)) {
			problems.push({ path: 'period_to', code: 'before_start', message: 'Окончание — не раньше начала' });
		} else if (monthIndex(input.period_to) > current) {
			problems.push({ path: 'period_to', code: 'in_future', message: 'Окончание — не позже текущего месяца' });
		}
	}
	if (problems.length > 0) throw new ApiError('validation_failed', { details: problems });
	const text = (value: string | null) => (value === null || value.trim() === '' ? null : value.trim());
	return {
		positionTitle: input.position_title.trim(),
		organizationName: text(input.organization_name),
		roleKey: input.role_key,
		periodFrom: `${input.period_from}-01`,
		periodTo: input.period_to === null ? null : `${input.period_to}-01`,
		isCurrent: input.period_to === null,
		skillKeys: skills,
		description: text(input.description)
	};
}

export interface ExperienceDeps {
	db: Database;
	now: () => Date;
}

async function journal(
	tx: Transaction,
	deps: ExperienceDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	candidateId: string,
	entryId: string,
	change: 'added' | 'updated' | 'removed'
) {
	await recordAuditEvent(tx, {
		action: 'profile.experience_changed',
		outcome: 'success',
		actor: auditActor(subject, meta, 'candidate'),
		object: { type: 'profile_experience_entry', id: entryId },
		subjectCandidateId: candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		details: { change },
		occurredAt: deps.now()
	});
}

export async function addManualExperience(
	deps: ExperienceDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: ExperienceInput
): Promise<string> {
	const { candidateId } = selfCandidate(subject);
	const values = await normalizeEntry(deps.db, input, deps.now());
	return deps.db.transaction(async (tx) => {
		await requireProcessingConsent(tx, candidateId, deps.now());
		const [held] = await tx
			.select({ count: count() })
			.from(profileExperienceEntries)
			.where(eq(profileExperienceEntries.candidateId, candidateId));
		if ((held?.count ?? 0) >= MAX_EXPERIENCE_ENTRIES) {
			throw new ApiError('conflict', {
				message: `В профиле уже ${MAX_EXPERIENCE_ENTRIES} мест работы`,
				details: [{ code: 'experience_full', message: String(MAX_EXPERIENCE_ENTRIES) }]
			});
		}
		const [row] = await tx
			.insert(profileExperienceEntries)
			.values({ candidateId, ...values })
			.returning({ id: profileExperienceEntries.id });
		if (!row) throw new Error('the experience entry was not inserted');
		await journal(tx, deps, subject, meta, candidateId, row.id, 'added');
		return row.id;
	});
}

export async function updateManualExperience(
	deps: ExperienceDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	entryId: string,
	input: ExperienceInput
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	const values = await normalizeEntry(deps.db, input, deps.now());
	await deps.db.transaction(async (tx) => {
		await requireProcessingConsent(tx, candidateId, deps.now());
		const updated = await tx
			.update(profileExperienceEntries)
			.set(values)
			.where(and(eq(profileExperienceEntries.id, entryId), eq(profileExperienceEntries.candidateId, candidateId)))
			.returning({ id: profileExperienceEntries.id });
		if (updated.length === 0) throw new ApiError('not_found');
		await journal(tx, deps, subject, meta, candidateId, entryId, 'updated');
	});
}

export async function removeManualExperience(
	deps: ExperienceDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	entryId: string
): Promise<void> {
	const { candidateId } = selfCandidate(subject);
	await deps.db.transaction(async (tx) => {
		const removed = await tx
			.delete(profileExperienceEntries)
			.where(and(eq(profileExperienceEntries.id, entryId), eq(profileExperienceEntries.candidateId, candidateId)))
			.returning({ id: profileExperienceEntries.id });
		if (removed.length === 0) throw new ApiError('not_found');
		await journal(tx, deps, subject, meta, candidateId, entryId, 'removed');
	});
}
