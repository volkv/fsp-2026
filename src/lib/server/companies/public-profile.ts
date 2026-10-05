// The profile of a company the candidate reads in an offer (docs/domain.md, sections 5.1, 13.5): the description, the
// line of business and the contacts of the organization, with the label of the check by an operator. The owner edits
// it while the admission policy lets the company act; an offer is sent only by a company whose description and line of
// business are filled in. Contacts are those of the organization, not of an employee.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { can, companyAdmission, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { Executor } from '$lib/server/db';
import { companies } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { auditActorOf, invalid, requirePermission, type ActionContext, type CompanyDeps } from './context';
import { admissionRefusal } from './gate';
import { lockCompany } from './rows';

export const DESCRIPTION_MAX = 3000;
export const ACTIVITY_MAX = 200;

export const companyContactsSchema = z.strictObject({
	website: z
		.string()
		.trim()
		.max(200)
		.regex(/^https?:\/\/[^\s/]+\.[^\s]+$/iu)
		.optional(),
	email: z
		.string()
		.trim()
		.max(200)
		.regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u)
		.optional(),
	phone: z
		.string()
		.trim()
		.regex(/^\+?[0-9 ()-]{5,30}$/u)
		.optional(),
	telegram: z
		.string()
		.trim()
		.regex(/^(?:@|https:\/\/t\.me\/)[A-Za-z0-9_]{4,64}$/u)
		.optional()
});

export type CompanyContacts = z.infer<typeof companyContactsSchema>;

export interface CompanyPublicProfile {
	id: string;
	displayName: string;
	description: string | null;
	activity: string | null;
	contacts: CompanyContacts;
	/** «Проверена» / «не проверена»: the label of the check by an operator, not of the admission. */
	verification: 'verified' | 'unverified';
	/** Description and line of business are filled in: the company may send offers. */
	complete: boolean;
}

function parseContacts(companyId: string, value: unknown): CompanyContacts {
	if (value === null) return {};
	const parsed = companyContactsSchema.safeParse(value);
	if (!parsed.success) throw new Error(`contacts of company ${companyId} do not match the schema`);
	return parsed.data;
}

/** The profile as stored, read by whoever is entitled to see it (the caller checked that). */
export async function loadCompanyProfile(executor: Executor, companyId: string): Promise<CompanyPublicProfile> {
	const [row] = await executor
		.select({
			id: companies.id,
			displayName: companies.displayName,
			description: companies.description,
			activity: companies.activity,
			contacts: companies.contacts,
			status: companies.status
		})
		.from(companies)
		.where(eq(companies.id, companyId));
	if (!row) throw new Error(`company ${companyId} does not exist`);
	return {
		id: row.id,
		displayName: row.displayName,
		description: row.description,
		activity: row.activity,
		contacts: parseContacts(row.id, row.contacts),
		verification: row.status === 'verified' ? 'verified' : 'unverified',
		complete: row.description !== null && row.activity !== null
	};
}

/** The profile for a member of the company (any role, a session or an API key). */
export async function companyProfileFor(
	executor: Executor,
	subject: AccessSubject,
	companyId: string
): Promise<CompanyPublicProfile> {
	const access = can(subject, 'company.profile.read', { companyId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return loadCompanyProfile(executor, companyId);
}

export interface CompanyProfilePatch {
	/** `null` clears the field. */
	description?: string | null;
	activity?: string | null;
	contacts?: CompanyContacts;
}

function text(details: ErrorDetail[], path: string, value: string | null, max: number): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.length > max) details.push({ path, code: 'too_long', message: `Не длиннее ${max} символов` });
	return trimmed;
}

/** The owner edits the profile while the admission policy lets the company act (domain 5.1). */
export async function updateCompanyProfile(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	patch: CompanyProfilePatch
): Promise<CompanyPublicProfile> {
	requirePermission(ctx.subject, 'company.profile.manage', { companyId });
	const details: ErrorDetail[] = [];
	const values: Partial<typeof companies.$inferInsert> = {};
	if (patch.description !== undefined) {
		values.description = text(details, 'description', patch.description, DESCRIPTION_MAX);
	}
	if (patch.activity !== undefined) values.activity = text(details, 'activity', patch.activity, ACTIVITY_MAX);
	if (patch.contacts !== undefined) {
		// An empty contact is no contact: the stored object names only what is filled in.
		const filled = Object.fromEntries(Object.entries(patch.contacts).filter(([, value]) => value.trim() !== ''));
		const parsed = companyContactsSchema.safeParse(filled);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				details.push({ path: ['contacts', ...issue.path].join('.'), code: 'invalid', message: 'Неверный формат' });
			}
		} else {
			values.contacts = Object.keys(parsed.data).length === 0 ? null : parsed.data;
		}
	}
	if (details.length > 0) throw invalid(details);
	return deps.db.transaction(async (tx) => {
		const company = await lockCompany(tx, companyId);
		const admission = companyAdmission(company.status);
		if (!admission.admitted) throw admissionRefusal(admission.reason);
		const fields = Object.keys(values);
		if (fields.length > 0) {
			await tx.update(companies).set(values).where(eq(companies.id, companyId));
			await recordAuditEvent(tx, {
				action: 'company.updated',
				outcome: 'success',
				actor: auditActorOf(ctx.subject),
				object: { type: 'company', id: companyId },
				requestId: ctx.meta.requestId,
				ip: ctx.meta.ip,
				userAgent: ctx.meta.userAgent,
				details: { fields }
			});
		}
		return loadCompanyProfile(tx, companyId);
	});
}
