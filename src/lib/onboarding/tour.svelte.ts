import { goto } from '$app/navigation';
import type { ResolvedPathname } from '$app/types';
import { permittedItems, type NavPermission } from '$lib/navigation.js';
import { visibleElement } from './dom.js';
import { hasMark, setMark, type TourMark, type TourOwner } from './storage.js';
import type { PageTour, WorkspaceTour } from './types.js';

/** A stop as the card shows it: the page to open first (main tour) and the element to frame. */
export interface ActiveStep {
	target: string | null;
	title: string;
	body: string;
	href: ResolvedPathname | null;
}

/**
 * State of the tours in the browser. One per tab: it changes only in event handlers and effects, which never run on
 * the server, so the module-level instance holds nothing of one request for another.
 */
class TourState {
	/** Whose marks are read and written; set by the layout once the signed-in person is known. */
	owner = $state<TourOwner | null>(null);
	welcomeOpen = $state(false);
	kind = $state<'main' | 'page' | null>(null);
	title = $state('');
	steps = $state.raw<ActiveStep[]>([]);
	index = $state(0);
	/** Grows with every start: the card takes the focus once per tour, not on every stop. */
	run = $state(0);
	/** Grows with every mark written, so readers of `seen` see the change. */
	#marks = $state(0);

	current = $derived(this.kind === null ? null : (this.steps[this.index] ?? null));

	seen(mark: TourMark): boolean {
		// Before the person is known the tour counts as seen: no blinking for a moment after the page loads. Reading
		// the counter subscribes the reader to new marks.
		return this.#marks < 0 || this.owner === null || hasMark(this.owner, mark);
	}

	mark(mark: TourMark): void {
		if (this.owner === null) return;
		setMark(this.owner, mark);
		this.#marks += 1;
	}

	/** The tour of the sections: the stops behind a permission the person lacks are dropped, as in the navigation. */
	startMain(tour: WorkspaceTour, permissions: readonly NavPermission[]): void {
		this.welcomeOpen = false;
		this.kind = 'main';
		this.title = 'Тур по кабинету';
		this.steps = permittedItems(tour.main, permissions).map(({ target, title, body, href }) => ({
			target,
			title,
			body,
			href
		}));
		this.run += 1;
		void this.show(0);
	}

	/** The tour of the current page, without the stops whose element is not on the page now. */
	startPage(page: PageTour): void {
		const steps = page.steps
			.filter((step) => step.target === null || visibleElement(step.target) !== null)
			.map((step) => ({ ...step, href: null }));
		this.mark(`page:${page.route}`);
		if (steps.length === 0) return;
		this.welcomeOpen = false;
		this.kind = 'page';
		this.title = page.title;
		this.steps = steps;
		this.run += 1;
		this.index = 0;
	}

	next(): void {
		if (this.index + 1 < this.steps.length) {
			void this.show(this.index + 1);
			return;
		}
		if (this.kind === 'main') this.mark('main');
		this.close();
	}

	back(): void {
		if (this.index > 0) void this.show(this.index - 1);
	}

	close(): void {
		this.kind = null;
		this.steps = [];
		this.index = 0;
	}

	private async show(index: number): Promise<void> {
		this.index = index;
		const step = this.steps[index];
		if (!step?.href || window.location.pathname === step.href) return;
		const href: ResolvedPathname = step.href;
		await goto(href);
	}
}

export const tour = new TourState();
