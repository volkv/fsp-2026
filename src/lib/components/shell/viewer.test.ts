import { describe, expect, it } from 'vitest';
import { permittedItems, WORKSPACES } from '$lib/navigation';
import { timeLeft, viewerFrom } from './viewer';

const viewer = {
	displayName: 'Оператор',
	workspace: 'operator',
	onboardingComplete: true,
	csrfToken: 't',
	demoSession: null
};

describe('viewerFrom', () => {
	it('reads the permissions the shell knows', () => {
		expect(viewerFrom({ viewer: { ...viewer, permissions: ['audit.read'] } })?.permissions).toEqual(['audit.read']);
	});

	it('refuses a viewer without permissions or with an unknown one', () => {
		expect(() => viewerFrom({ viewer })).toThrow(/malformed viewer/);
		expect(() => viewerFrom({ viewer: { ...viewer, permissions: ['staff.manage'] } })).toThrow(/malformed viewer/);
	});
});

describe('demo session of the viewer', () => {
	it('reads the moment the session is removed and refuses a malformed one', () => {
		const expiresAt = new Date('2026-10-05T12:00:00Z');
		expect(viewerFrom({ viewer: { ...viewer, permissions: [], demoSession: { expiresAt } } })?.demoSession).toEqual({
			expiresAt
		});
		expect(() =>
			viewerFrom({ viewer: { ...viewer, permissions: [], demoSession: { expiresAt: '2026-10-05' } } })
		).toThrow(/malformed viewer/);
		expect(() => viewerFrom({ viewer: { ...viewer, permissions: [], demoSession: undefined } })).toThrow(
			/malformed viewer/
		);
	});

	it('says the time left in hours and minutes', () => {
		const until = new Date('2026-10-05T12:00:00Z');
		expect(timeLeft(until, until.getTime() - (5 * 60 + 12) * 60_000)).toBe('5 ч 12 мин');
		expect(timeLeft(until, until.getTime() - 40 * 60_000)).toBe('40 мин');
		expect(timeLeft(until, until.getTime() + 60_000)).toBe('0 мин');
	});
});

describe('operator sections', () => {
	const hrefs = (permissions: Parameters<typeof permittedItems>[1]) =>
		permittedItems(WORKSPACES.operator.items, permissions).map((item) => item.href);

	it('show the journal only with `audit.read`', () => {
		expect(hrefs([])).not.toContain('/operator/audit');
		expect(hrefs(['audit.read'])).toContain('/operator/audit');
		expect(hrefs(['audit.read'])).toHaveLength(WORKSPACES.operator.items.length);
	});
});
