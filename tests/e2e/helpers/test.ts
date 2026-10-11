// The test API of every spec. The application under test takes the client address from `X-Forwarded-For`
// (`ADDRESS_HEADER`, as on the stand behind Caddy: docker-compose.prod.yml), and each test is a visitor of its own
// address: browser contexts and API requests of a test carry one random private address. The per-address limits
// (src/lib/server/http/rate-limit.ts) then count each test on its own, as they count each person on the stand, instead
// of the whole suite sharing the budget of one loopback address. A request without the header is refused by the
// application (adapter-node), so a spec that imports `test` from `@playwright/test` directly fails loudly.
import { randomInt } from 'node:crypto';
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/** An address from 10.0.0.0/8: never a real client, and one test does not meet another's by chance. */
export function visitorAddress(): string {
	return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

// The tours of the cabinets (src/lib/onboarding) open a one-time invitation on the first page of every cabinet; a spec
// that is not about them sees every tour as already seen. The browser reads the marks through `localStorage`, so the
// test answers for it, and the product keeps no switch of its own. A spec of the tours sets `test.use({ tours: true })`.
export const test = base.extend<{ tours: boolean }>({
	tours: [false, { option: true }],
	extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
		await use({ ...extraHTTPHeaders, 'x-forwarded-for': visitorAddress() });
	},
	context: async ({ context, tours }, use) => {
		if (!tours) {
			await context.addInitScript(() => {
				const getItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')?.value as (
					this: Storage,
					key: string
				) => string | null;
				Storage.prototype.getItem = function (this: Storage, key: string) {
					return key.startsWith('fsp:tour:') ? 'seen' : getItem.call(this, key);
				};
			});
		}
		await use(context);
	}
});
