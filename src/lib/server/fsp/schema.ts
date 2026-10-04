// Zod mirror of `contracts/fsp-achievements/v1.schema.json` for the responses the adapter reads. Objects are open
// within v1: fields the mirror does not know are dropped, so an addition of the source never reaches storage
// unreviewed. A value of an enumeration marked `Known<T>` that the mirror does not know becomes `'unknown'` with
// the original string in `rawValues` (contracts 1.3); any other violation fails the whole response.
import { z } from 'zod';
import { AWARDS } from '$lib/fsp/awards';
import {
	AGE_GROUPS,
	COMPETITION_LEVELS,
	DISCIPLINE_CODES,
	EVSK_RANKS,
	QUALIFICATION_RANKS,
	RESULT_STATUSES,
	STAGES,
	TEAM_ROLES,
	WEBHOOK_EVENT_TYPES,
	type Athlete,
	type Competition,
	type Discipline,
	type Known,
	type Qualification,
	type Result,
	type ResultTeam,
	type WebhookEvent
} from './types';

const text = z.string().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const isoDateTime = z.iso.datetime({ offset: true });
const rawValues = z.record(z.string(), z.string());

/** Maps a raw enumeration value; an unmapped one is recorded under `path` in `raw`. */
function known<T extends string>(
	allowed: readonly T[],
	value: string,
	raw: Record<string, string>,
	path: string
): Known<T> {
	if ((allowed as readonly string[]).includes(value)) return value as T;
	if (value !== 'unknown') raw[path] = value;
	return 'unknown';
}

function knownOptional<T extends string>(
	allowed: readonly T[],
	value: string | undefined,
	raw: Record<string, string>,
	path: string
): Known<T> | undefined {
	return value === undefined ? undefined : known(allowed, value, raw, path);
}

function withRaw<T extends object>(value: T, raw: Record<string, string>): T & { rawValues?: Record<string, string> } {
	return Object.keys(raw).length === 0 ? value : { ...value, rawValues: raw };
}

/** Drops members whose value is `undefined`, so an absent field stays absent (not `null`). */
function compact<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T;
}

const disciplineSchema = z
	.object({
		code: z.enum(DISCIPLINE_CODES),
		name: text,
		vrvsCode: z.string().regex(/^\d{10}Я$/),
		format: z.enum(['individual', 'team', 'both'])
	})
	.transform((d): Discipline => ({ code: d.code, name: d.name, vrvsCode: d.vrvsCode, format: d.format }));

export const competitionSchema = z
	.object({
		id: text,
		ekpNumber: z
			.string()
			.regex(/^\d{16}$/)
			.nullable(),
		title: text,
		discipline: z.string(),
		level: z.string(),
		stage: z.string().optional(),
		ageGroup: z.string().optional(),
		format: z.enum(['individual', 'team']).optional(),
		startDate: isoDate,
		endDate: isoDate.optional(),
		location: z.string().optional(),
		online: z.boolean().optional(),
		platform: z.string().nullable().optional(),
		participantsCount: z.int().min(0).optional(),
		regionsCount: z.int().min(0).optional(),
		protocolUrl: z.string().nullable().optional(),
		rawValues: rawValues.optional()
	})
	.transform((c): Competition => {
		const raw = { ...c.rawValues };
		return withRaw(
			compact({
				id: c.id,
				ekpNumber: c.ekpNumber,
				title: c.title,
				discipline: known(DISCIPLINE_CODES, c.discipline, raw, 'discipline'),
				level: known(COMPETITION_LEVELS, c.level, raw, 'level'),
				stage: knownOptional(STAGES, c.stage, raw, 'stage'),
				ageGroup: knownOptional(AGE_GROUPS, c.ageGroup, raw, 'ageGroup'),
				format: c.format,
				startDate: c.startDate,
				endDate: c.endDate,
				location: c.location,
				online: c.online,
				platform: c.platform,
				participantsCount: c.participantsCount,
				regionsCount: c.regionsCount,
				protocolUrl: c.protocolUrl
			}),
			raw
		);
	});

const teamSchema = z.object({
	id: text,
	name: text,
	region: z.string().optional(),
	size: z.int().min(1).optional(),
	role: z.string().optional(),
	specialization: z.string().nullable().optional()
});

export const resultSchema = z
	.object({
		id: text,
		competitionId: text,
		place: z.int().min(1).nullable(),
		placeOf: z.int().min(1).optional(),
		score: z.number().nullable().optional(),
		solved: z.int().min(0).nullable().optional(),
		penaltyMinutes: z.int().min(0).nullable().optional(),
		team: teamSchema.nullable().optional(),
		award: z.string().optional(),
		evskFulfilled: z.enum(EVSK_RANKS).nullable().optional(),
		status: z.enum(RESULT_STATUSES),
		publishedAt: isoDateTime.optional(),
		rawValues: rawValues.optional()
	})
	.transform((r): Result => {
		const raw = { ...r.rawValues };
		const team: ResultTeam | null | undefined =
			r.team == null
				? r.team
				: compact({
						id: r.team.id,
						name: r.team.name,
						region: r.team.region,
						size: r.team.size,
						role: knownOptional(TEAM_ROLES, r.team.role, raw, 'team.role'),
						specialization: r.team.specialization
					});
		return withRaw(
			compact({
				id: r.id,
				competitionId: r.competitionId,
				place: r.place,
				placeOf: r.placeOf,
				score: r.score,
				solved: r.solved,
				penaltyMinutes: r.penaltyMinutes,
				team,
				award: knownOptional(AWARDS, r.award, raw, 'award'),
				evskFulfilled: r.evskFulfilled,
				status: r.status,
				publishedAt: r.publishedAt
			}),
			raw
		);
	});

const qualificationSchema = z
	.object({
		id: text.optional(),
		rank: z.string(),
		discipline: z.string().optional(),
		assignedAt: isoDate,
		validUntil: isoDate.nullable().optional(),
		orderNumber: z.string().nullable().optional(),
		assignedBy: z.string().optional(),
		basisCompetitionId: z.string().nullable().optional(),
		rawValues: rawValues.optional()
	})
	.transform((q): Qualification => {
		const raw = { ...q.rawValues };
		return withRaw(
			compact({
				id: q.id,
				rank: known(QUALIFICATION_RANKS, q.rank, raw, 'rank'),
				discipline: knownOptional(DISCIPLINE_CODES, q.discipline, raw, 'discipline'),
				assignedAt: q.assignedAt,
				validUntil: q.validUntil,
				orderNumber: q.orderNumber,
				assignedBy: q.assignedBy,
				basisCompetitionId: q.basisCompetitionId
			}),
			raw
		);
	});

export const athleteSchema = z
	.object({
		fspId: text,
		lastName: text,
		firstName: text,
		middleName: z.string().nullable().optional(),
		birthYear: z.int().min(1900).nullable().optional(),
		region: z.string().optional(),
		nationalTeam: z
			.object({ discipline: z.enum(DISCIPLINE_CODES), squad: z.enum(['main', 'reserve']), season: z.int() })
			.nullable()
			.optional(),
		platformAccounts: z
			.array(z.object({ platform: text, login: text, rating: z.number().nullable().optional() }))
			.optional()
	})
	.transform((a): Athlete =>
		compact({
			fspId: a.fspId,
			lastName: a.lastName,
			firstName: a.firstName,
			middleName: a.middleName,
			birthYear: a.birthYear,
			region: a.region,
			nationalTeam: a.nationalTeam,
			platformAccounts: a.platformAccounts?.map((p) =>
				compact({ platform: p.platform, login: p.login, rating: p.rating })
			)
		})
	);

const pageInfoSchema = z.object({
	number: z.int().min(1),
	size: z.int().min(1),
	totalPages: z.int().min(1),
	totalResults: z.int().min(0)
});

export const achievementsPageSchema = z.object({
	athlete: athleteSchema,
	qualifications: z.array(qualificationSchema),
	results: z.array(resultSchema),
	competitions: z.array(competitionSchema),
	generatedAt: isoDateTime,
	sourceVersion: text,
	page: pageInfoSchema,
	complete: z.boolean().optional()
});
export type AchievementsPage = z.output<typeof achievementsPageSchema>;

export const disciplineListSchema = z.object({ items: z.array(disciplineSchema) });

export const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const webhookEventSchema = z
	.object({
		eventId: text,
		type: z.enum(WEBHOOK_EVENT_TYPES),
		occurredAt: isoDateTime,
		athleteIds: z.array(text).min(1),
		competitionId: text.optional()
	})
	.transform((e): WebhookEvent =>
		compact({
			eventId: e.eventId,
			type: e.type,
			occurredAt: e.occurredAt,
			athleteIds: e.athleteIds,
			competitionId: e.competitionId
		})
	);
