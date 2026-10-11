import type { Workspace } from '$lib/navigation.js';

/**
 * What a person has seen of the tours, kept in the browser: per account and workspace, so a new demo session (a new
 * account) starts afresh. Storage may be missing or refuse writes (private mode, blocked site data): then every tour
 * counts as unseen and nothing breaks.
 *
 * - `welcome` — the invitation was shown and answered;
 * - `main` — the tour of the sections was walked to the end;
 * - `page:<route>` — the tour of that page was opened.
 */
export type TourMark = 'welcome' | 'main' | `page:${string}`;

export interface TourOwner {
	userId: string;
	workspace: Workspace;
}

export const markKey = (owner: TourOwner, mark: TourMark): string =>
	`fsp:tour:${owner.userId}:${owner.workspace}:${mark}`;

export function hasMark(owner: TourOwner, mark: TourMark): boolean {
	try {
		return window.localStorage.getItem(markKey(owner, mark)) !== null;
	} catch {
		return false;
	}
}

export function setMark(owner: TourOwner, mark: TourMark): void {
	try {
		window.localStorage.setItem(markKey(owner, mark), new Date().toISOString());
	} catch {
		// Without storage the mark lives until the page is reloaded (the state of the tour keeps it).
	}
}
