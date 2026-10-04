// The hiring process after an accepted invitation (contracts 5.5; domain 13.7): each side reports stages and the
// outcome in its own append-only messages; the state shows where the sides agree and where they differ.
import { z } from 'zod';
import { HIRING_STAGES } from '$lib/server/consent/kinds';
import { getHiringProcess, reportHiring, type HiringProcessView } from '$lib/server/hiring/process';
import { OUTCOMES } from '$lib/server/hiring/state';
import { defineOperation } from '../operation';
import { date, dateTime, id, iso, isoOrNull } from '../schemas';
import { invitationDeps } from '../services';
import { invitationMeta, type BaseContext } from './context';

const TAG = 'Найм';

const processParams = z.strictObject({ process_id: id('Процесс найма') });
const party = z.enum(['company', 'candidate']);

const processSchema = z
	.object({
		id: z.uuid(),
		invitation_id: z.uuid(),
		viewer: party,
		opened_at: dateTime,
		outcome_due_at: dateTime,
		stage: z
			.object({ stage: z.enum(HIRING_STAGES), reported_by: z.array(party) })
			.nullable()
			.describe('Самый дальний этап, о котором сообщила хотя бы одна сторона'),
		outcome: z
			.enum(['pending', 'single_party', 'confirmed', 'diverged', 'unknown'])
			.describe('Исход: `confirmed` — стороны согласны, `diverged` — расходятся, `unknown` — не сообщён в срок'),
		overdue: z.boolean(),
		result: z.enum(['hired', 'not_hired']).nullable(),
		confirmed_at: dateTime.nullable(),
		other_side_differs: z.boolean(),
		reports: z.array(
			z.object({
				id: z.uuid(),
				party,
				kind: z.enum(['stage', 'outcome']),
				stage: z.enum(HIRING_STAGES).nullable(),
				outcome: z.enum(OUTCOMES).nullable(),
				start_date: date.nullable(),
				reason_code: z.string().nullable().describe('Причину видит только сообщившая сторона'),
				supersedes_report_id: z.uuid().nullable(),
				reported_at: dateTime
			})
		)
	})
	.meta({ id: 'HiringProcess', description: 'Процесс найма глазами одной из сторон' });

function processView(view: HiringProcessView) {
	return {
		id: view.id,
		invitation_id: view.invitationId,
		viewer: view.viewer,
		opened_at: iso(view.openedAt),
		outcome_due_at: iso(view.outcomeDueAt),
		stage: view.stage && { stage: view.stage.stage, reported_by: view.stage.reportedBy },
		outcome: view.outcome,
		overdue: view.overdue,
		result: view.result,
		confirmed_at: isoOrNull(view.confirmedAt),
		other_side_differs: view.otherSideDiffers,
		reports: view.reports.map((report) => ({
			id: report.id,
			party: report.party,
			kind: report.kind,
			stage: report.stage,
			outcome: report.outcome,
			start_date: report.startDate,
			reason_code: report.reasonCode,
			supersedes_report_id: report.supersedesReportId,
			reported_at: iso(report.reportedAt)
		}))
	};
}

async function loadProcess(ctx: BaseContext, processId: string) {
	return processView(await getHiringProcess(invitationDeps(ctx.services), await ctx.subject(), processId));
}

export const getProcess = defineOperation({
	id: 'getHiringProcess',
	method: 'GET',
	path: '/hiring/{process_id}',
	tag: TAG,
	summary: 'Процесс найма',
	description: 'Состояние процесса с расхождениями сторон. Не сторона процесса — `404`.',
	auth: 'account',
	permission: 'invitation.read',
	params: processParams,
	errors: ['not_found'],
	response: { status: 200, description: 'Процесс', schema: processSchema },
	handle: (ctx) => loadProcess(ctx, ctx.params.process_id)
});

export const reportProcess = defineOperation({
	id: 'reportHiring',
	method: 'POST',
	path: '/hiring/{process_id}/reports',
	tag: TAG,
	summary: 'Сообщить этап или исход',
	description:
		'Сообщение своей стороны: компания — участником или ключом API, кандидат — в сессии. Другая сторона свои ' +
		'сообщения не меняет; исправление заменяет своё прежнее сообщение того же вида (`supersedes_report_id`). ' +
		'Приостановленная компания больше не сообщает.',
	auth: 'account',
	permission: 'hiring.report',
	idempotent: true,
	params: processParams,
	body: z.strictObject({
		kind: z.enum(['stage', 'outcome']),
		stage: z.enum(HIRING_STAGES).optional().describe('С `kind = stage`'),
		outcome: z.enum(OUTCOMES).optional().describe('С `kind = outcome`'),
		start_date: z.iso.date().optional().describe('Дата выхода, только с `outcome = hired`'),
		reason_code: z.string().optional(),
		supersedes_report_id: z.uuid().optional()
	}),
	errors: ['not_found', 'conflict'],
	response: {
		status: 201,
		description: 'Сообщение записано',
		schema: z.object({ report_id: z.uuid(), process: processSchema })
	},
	async handle(ctx) {
		const subject = await ctx.subject();
		const body = ctx.body;
		const reported = await reportHiring(
			invitationDeps(ctx.services),
			subject,
			invitationMeta(ctx),
			ctx.params.process_id,
			{
				party: subject.via === 'session' && subject.candidate !== null ? 'candidate' : 'company',
				kind: body.kind,
				...(body.stage === undefined ? {} : { stage: body.stage }),
				...(body.outcome === undefined ? {} : { outcome: body.outcome }),
				...(body.start_date === undefined ? {} : { startDate: body.start_date }),
				...(body.reason_code === undefined ? {} : { reasonCode: body.reason_code }),
				...(body.supersedes_report_id === undefined ? {} : { supersedesReportId: body.supersedes_report_id })
			}
		);
		return { report_id: reported.reportId, process: await loadProcess(ctx, ctx.params.process_id) };
	}
});
