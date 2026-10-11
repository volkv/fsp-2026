import { NAV_PERMISSIONS, type NavPermission, type Workspace } from '$lib/navigation.js';

/** The signed-in person as the interface shows them; built on the server for every page of the layout. */
export interface Viewer {
	/** Account id: the browser keeps what the person has seen of the tours per account. */
	id: string;
	displayName: string;
	/** Workspace by role; `null` while the registration path has not given one. */
	workspace: Workspace | null;
	/** Registration steps are done: the workspace is the home, not the onboarding page. */
	onboardingComplete: boolean;
	/** Permissions of the viewer that change the sections shown (`NAV_PERMISSIONS`), checked on this request. */
	permissions: NavPermission[];
	/** Token the forms of the page send back as `csrf_token`. */
	csrfToken: string;
	/** The live demo session the account is a clone of, with the moment it is removed; `null` — not a clone. */
	demoSession: { expiresAt: Date } | null;
}

/** Name of the hidden form field that carries the session CSRF token. */
export const CSRF_FIELD = 'csrf_token';

const isNavPermission = (value: unknown): value is NavPermission =>
	(NAV_PERMISSIONS as readonly unknown[]).includes(value);

const WORKSPACE_VALUES: readonly (string | null)[] = ['candidate', 'employer', 'operator', 'admin', null];

const isDemoSession = (value: unknown): boolean =>
	value === null || (typeof value === 'object' && (value as Record<string, unknown>).expiresAt instanceof Date);

/**
 * Time left until a moment, as the interface says it: «6 сут. 23 ч», «5 ч 12 мин», «40 мин»; a moment passed is
 * «0 мин».
 */
export function timeLeft(until: Date, now: number): string {
	const minutes = Math.max(0, Math.round((until.getTime() - now) / 60_000));
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) return `${Math.floor(hours / 24)} сут. ${hours % 24} ч`;
	return hours > 0 ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

/** A term in minutes as the interface says it: «20 мин», «8 ч», «7 сут.», «1 ч 30 мин». */
export function termText(minutes: number): string {
	if (minutes < 60) return `${minutes} мин`;
	if (minutes % 1440 === 0) return `${minutes / 1440} сут.`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours} ч` : `${hours} ч ${minutes % 60} мин`;
}

/** Reads the viewer from layout data, which is typed loosely across pages. */
export function viewerFrom(data: Record<string, unknown>): Viewer | null {
	const value: unknown = data.viewer;
	if (typeof value !== 'object' || value === null) return null;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.id !== 'string' ||
		typeof candidate.displayName !== 'string' ||
		typeof candidate.onboardingComplete !== 'boolean' ||
		typeof candidate.csrfToken !== 'string' ||
		!Array.isArray(candidate.permissions) ||
		!candidate.permissions.every(isNavPermission) ||
		!WORKSPACE_VALUES.includes(candidate.workspace as string | null) ||
		!isDemoSession(candidate.demoSession)
	) {
		throw new Error('layout data carries a malformed viewer');
	}
	return value as Viewer;
}
