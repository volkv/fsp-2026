import type { Action } from 'svelte/action';

/**
 * Marks an element `data-reveal="pending"` once it is mounted and `"in"` when it enters the window, so CSS can play
 * its entrance once. Without JavaScript or with reduced motion the attribute is never set and the final state shows.
 */
export const reveal: Action<HTMLElement, number | undefined> = (node, threshold = 0.3) => {
	if (typeof IntersectionObserver === 'undefined') return;
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	node.dataset.reveal = 'pending';
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) {
				node.dataset.reveal = 'in';
				observer.disconnect();
			}
		},
		{ threshold }
	);
	observer.observe(node);
	return {
		destroy: () => {
			observer.disconnect();
		}
	};
};
