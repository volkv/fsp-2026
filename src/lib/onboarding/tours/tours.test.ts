import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACES, type Workspace } from '$lib/navigation';
import { inCabinet, routeKey } from '../routes';
import { WORKSPACE_TOURS } from './index';

const ROUTES = 'src/routes';

function files(dir: string, keep: (name: string) => boolean): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return files(path, keep);
		return keep(entry.name) ? [path] : [];
	});
}

/** Route keys of every page of the application, as `routeKey` gives them for `page.route.id`. */
const pages = files(ROUTES, (name) => name === '+page.svelte').map((path) => {
	const dir = relative(ROUTES, path).split(sep).slice(0, -1).join('/');
	return routeKey(`/${dir}`);
});

const markup = files('src', (name) => name.endsWith('.svelte'))
	.map((path) => readFileSync(path, 'utf8'))
	.join('\n');

/** Pages of a cabinet that the tours must cover: every page under its sections, less the service pages. */
const CABINET_ROOTS: Record<Workspace, RegExp> = {
	candidate: /^\/(me|notifications)(\/|$)/,
	employer: /^\/company(\/|$)/,
	operator: /^\/operator(\/|$)/,
	admin: /^\/admin(\/|$)/
};

const tours = Object.values(WORKSPACE_TOURS);
const allSteps = tours.flatMap((tour) => [...tour.main, ...tour.pages.flatMap((page) => page.steps)]);

describe('tours of the cabinets', () => {
	it('cover every section of the navigation, in the main tour', () => {
		for (const tour of tours) {
			const hrefs = tour.main.map((step) => step.href);
			for (const item of WORKSPACES[tour.workspace].items) expect(hrefs, tour.workspace).toContain(item.href);
		}
	});

	it('start the main tour on the tour button', () => {
		for (const tour of tours) expect(tour.main[0]?.target, tour.workspace).toBe('[data-tour="tour-button"]');
	});

	it('have a tour for every page of the cabinet, and only for pages that exist', () => {
		for (const tour of tours) {
			const routes = tour.pages.map((page) => page.route);
			expect(new Set(routes).size, tour.workspace).toBe(routes.length);
			for (const route of routes) expect(pages, route).toContain(route);
			const cabinet = pages.filter(
				(page) => CABINET_ROOTS[tour.workspace].test(page) && inCabinet(tour.workspace, page)
			);
			for (const page of cabinet) expect(routes, `${tour.workspace} ${page}`).toContain(page);
		}
	});

	it('keep page tours short', () => {
		for (const page of tours.flatMap((tour) => tour.pages)) {
			expect(page.steps.length, page.route).toBeGreaterThan(0);
			expect(page.steps.length, page.route).toBeLessThanOrEqual(4);
		}
	});

	it('say every stop in one short sentence', () => {
		for (const step of allSteps) {
			expect(step.title.length, step.title).toBeLessThanOrEqual(60);
			expect(step.body.length, step.body).toBeLessThanOrEqual(140);
		}
	});

	it('point only at marks present in the markup', () => {
		for (const step of allSteps) {
			if (step.target === null) continue;
			for (const [, attribute, value] of step.target.matchAll(/\[data-(tour|testid)="([^"]+)"\]/g)) {
				if (value === undefined || (attribute === 'tour' && value.startsWith('nav:'))) continue;
				expect(markup.includes(`"${value}"`) || markup.includes(`'${value}'`), step.target).toBe(true);
			}
		}
	});
});

describe('routes of the tours', () => {
	it('drop the route groups', () => {
		expect(routeKey('/(app)/company/(member)/needs/[id]')).toBe('/company/needs/[id]');
		expect(routeKey('/(app)')).toBe('/');
	});

	it('invite only on the pages of the cabinet', () => {
		expect(inCabinet('candidate', '/me/profile')).toBe(true);
		expect(inCabinet('candidate', '/company/needs')).toBe(false);
		expect(inCabinet('employer', '/company/join')).toBe(false);
		expect(inCabinet('candidate', '/account/deleted')).toBe(false);
		expect(inCabinet('candidate', '/onboarding/survey')).toBe(false);
	});
});
