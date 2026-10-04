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

export const test = base.extend({
	extraHTTPHeaders: async ({ extraHTTPHeaders }, use) => {
		await use({ ...extraHTTPHeaders, 'x-forwarded-for': visitorAddress() });
	}
});
