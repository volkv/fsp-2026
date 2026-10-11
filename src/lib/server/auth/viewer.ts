// The signed-in person for the interface: name, workspace by role (domain 4.1), the permissions that change the
// sections shown, the state of the registration path and, for a clone, the demo session it lives in (domain 19.3).
// Read from the database on every request: roles are never cached in the session.
import { eq } from 'drizzle-orm';
import type { Viewer } from '$lib/components/shell/viewer';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { loadAccessSubject } from '$lib/server/companies/subject';
import { hasOpenPartnership } from '$lib/server/partner-pool/pool';
import { users } from '$lib/server/db/schema';
import { idleEndOf } from '$lib/server/demo/activity';
import { demoTerms } from '$lib/server/demo/terms';
import { sessionOfAccount } from '$lib/server/demo/visit';
import { NAV_PERMISSIONS, type NavPermission, type Workspace } from '$lib/navigation';
import type { SessionActor } from './authenticate';
import type { AuthDeps } from './context';
import { onboardingState, type OnboardingState } from './onboarding';

function staffWorkspace(subject: AccessSubject): Workspace | null {
	if (subject.staff.admin) return 'admin';
	if (subject.staff.operator) return 'operator';
	return null;
}

/**
 * The permissions of `NAV_PERMISSIONS` the subject holds, by the same `can` the pages behind the sections check. The
 * pool of a competition partner is an object right: the section shows while the company has an open partnership.
 */
export function navPermissions(subject: AccessSubject, openPartnership: boolean): NavPermission[] {
	return NAV_PERMISSIONS.filter((permission) =>
		permission === 'partner_pool.read'
			? openPartnership &&
				subject.membership !== null &&
				can(subject, permission, {
					partnershipCompanyId: subject.membership.companyId,
					partnershipActive: true
				}).allowed
			: can(subject, permission, null).allowed
	);
}

export async function loadViewer(
	deps: AuthDeps,
	actor: SessionActor
): Promise<{ viewer: Viewer; onboarding: OnboardingState }> {
	const [user] = await deps.db.select({ displayName: users.displayName }).from(users).where(eq(users.id, actor.userId));
	if (!user) throw new Error(`session user ${actor.userId} does not exist`);
	const onboarding = await onboardingState(deps, actor.userId);
	const subject = await loadAccessSubject(deps.db, actor);
	const staff = staffWorkspace(subject);
	const demo = await sessionOfAccount(deps.db, actor.userId, deps.now());
	// The request itself uses the session: it goes when nobody comes back for the idle time, or at its own end.
	const demoSession = demo
		? { expiresAt: idleEndOf(demo.expiresAt, deps.now(), (await demoTerms(deps.db)).idleMinutes) }
		: null;
	return {
		viewer: {
			id: actor.userId,
			displayName: user.displayName ?? 'Без имени',
			workspace: staff ?? onboarding.role,
			onboardingComplete: staff !== null || onboarding.complete,
			permissions: navPermissions(
				subject,
				subject.membership?.status === 'active' &&
					(await hasOpenPartnership(deps.db, subject.membership.companyId, deps.now()))
			),
			csrfToken: actor.csrfToken,
			demoSession
		},
		onboarding
	};
}
