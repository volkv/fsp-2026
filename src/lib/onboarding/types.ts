import type { ResolvedPathname } from '$app/types';
import type { NavPermission, Workspace } from '$lib/navigation.js';

/**
 * One stop of a tour: a frame around an element of the page and a short card next to it. The target is a CSS
 * selector; the first visible match is framed (the same element may be rendered twice, for the desktop and the
 * narrow-screen layout). `null` — the card stands in the middle of the screen without a frame.
 */
export interface TourStep {
	target: string | null;
	title: string;
	/** One sentence: what the person gets here or what to do. */
	body: string;
}

/** A stop of the main tour: a section of the workspace. The tour opens the page, then frames its navigation item. */
export interface MainTourStep extends TourStep {
	/** Page of the section; `null` — the stop stays on the current page (header elements). */
	href: ResolvedPathname | null;
	/** Shown only to a viewer holding the permission, as the navigation item itself. */
	permission?: NavPermission;
}

/** The tour of one page: what to do on it, in one to four stops. Stops whose element is absent are skipped. */
export interface PageTour {
	/**
	 * Route of the page as SvelteKit names it, without route groups: `/me/invitations/[id]`,
	 * `/company/needs/[id]` (the `(app)` and `(member)` groups are dropped).
	 */
	route: string;
	/** Name of the page in the tour menu: «Тур по странице „Приглашение“». */
	title: string;
	steps: TourStep[];
}

/** Everything a workspace offers: the one-time invitation, the tour of its sections and the tours of its pages. */
export interface WorkspaceTour {
	workspace: Workspace;
	welcome: { title: string; body: string };
	main: MainTourStep[];
	pages: PageTour[];
}

/** Selector of an element marked for the tours: `data-tour="<name>"` in the markup. */
export const tourTarget = (name: string): string => `[data-tour="${name}"]`;

/** Selector of an element by its test id, the stable mark most blocks of the pages already carry. */
export const testId = (id: string): string => `[data-testid="${id}"]`;

/** Selector of a navigation item of the workspace: `NavLinks` marks every item with its page. */
export const navItem = (href: string): string => tourTarget(`nav:${href}`);

/** The tour button in the header; the main tour ends on it. */
export const TOUR_BUTTON = tourTarget('tour-button');
