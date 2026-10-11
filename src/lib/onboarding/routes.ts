import type { Workspace } from '$lib/navigation.js';
import type { PageTour, WorkspaceTour } from './types.js';

/** Route id of SvelteKit without its groups: `/(app)/company/(member)/needs/[id]` → `/company/needs/[id]`. */
export function routeKey(routeId: string): string {
	const key = routeId.replace(/\/\([^)]+\)/g, '');
	return key === '' ? '/' : key;
}

/** Tour of the page the route belongs to; `null` — the page has none. */
export function pageTourFor(tour: WorkspaceTour, routeId: string | null): PageTour | null {
	if (routeId === null) return null;
	const key = routeKey(routeId);
	return tour.pages.find((page) => page.route === key) ?? null;
}

/** Pages of a cabinet: where the invitation to the tour may appear. Registration and service pages are outside. */
const CABINET_PREFIXES: Record<Workspace, readonly string[]> = {
	candidate: ['/me', '/account', '/notifications'],
	employer: ['/company'],
	operator: ['/operator'],
	admin: ['/admin']
};

const SERVICE_PAGES: readonly string[] = ['/company/join', '/account/deleted'];

export function inCabinet(workspace: Workspace, pathname: string): boolean {
	if (SERVICE_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`))) return false;
	return CABINET_PREFIXES[workspace].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
