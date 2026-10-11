/**
 * First element matching the selector that is actually rendered: the same mark may stand on the desktop row and in the
 * narrow-screen menu, and only one of them has boxes at a time.
 */
export function visibleElement(selector: string): HTMLElement | null {
	for (const element of document.querySelectorAll<HTMLElement>(selector)) {
		if (element.getClientRects().length > 0) return element;
	}
	return null;
}

/** Waits for the element to appear (a page loads its blocks after navigation), giving up after `timeout` ms. */
export function waitForElement(selector: string, timeout: number, signal: AbortSignal): Promise<HTMLElement | null> {
	const found = visibleElement(selector);
	if (found) return Promise.resolve(found);
	return new Promise((resolve) => {
		const finish = (element: HTMLElement | null): void => {
			observer.disconnect();
			clearTimeout(timer);
			signal.removeEventListener('abort', abort);
			resolve(element);
		};
		const abort = (): void => {
			finish(null);
		};
		const observer = new MutationObserver(() => {
			const element = visibleElement(selector);
			if (element) finish(element);
		});
		const timer = setTimeout(() => {
			finish(visibleElement(selector));
		}, timeout);
		observer.observe(document.body, { childList: true, subtree: true, attributes: true });
		signal.addEventListener('abort', abort);
	});
}

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
