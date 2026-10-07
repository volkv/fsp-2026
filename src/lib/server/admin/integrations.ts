// State of the integrations for the administrator: what is configured (addresses and names, never secrets), whether
// the internal services answer right now, and the latest traces each integration leaves in the database. A probe that
// fails is shown as down with its reason; the details stay in the server log.
import { and, count, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import type { ActionContext } from '$lib/server/companies/context';
import { requirePermission } from '$lib/server/companies/context';
import type { Config } from '$lib/server/config';
import type { Executor } from '$lib/server/db';
import { athleteLinks, inboundEvents, notificationChannels } from '$lib/server/db/schema';
import type { HealthReport } from '$lib/server/health';

const PROBE_TIMEOUT_MS = 2_000;

export interface Probe {
	status: 'up' | 'down';
	/** What answered (a version) or why the probe failed, in words for the page. */
	detail: string;
}

export interface IntegrationsDeps {
	db: Executor;
	config: Pick<Config, 'docparse' | 'sandbox' | 'fspId' | 'fspAchievements' | 'telegram'>;
	health: () => Promise<HealthReport>;
	fetch: typeof fetch;
}

async function probe<T>(
	name: string,
	deps: Pick<IntegrationsDeps, 'fetch'>,
	url: string,
	schema: z.ZodType<T>,
	describe: (body: T) => string
): Promise<Probe> {
	try {
		const response = await deps.fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!response.ok) return { status: 'down', detail: `ответ ${response.status}` };
		const parsed = schema.safeParse(await response.json());
		if (!parsed.success) return { status: 'down', detail: 'ответ не по контракту' };
		return { status: 'up', detail: describe(parsed.data) };
	} catch (error) {
		console.error(`[admin] ${name} probe failed`, error);
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			return { status: 'down', detail: `нет ответа за ${PROBE_TIMEOUT_MS / 1000} с` };
		}
		if (error instanceof SyntaxError) return { status: 'down', detail: 'ответ не JSON' };
		return { status: 'down', detail: 'сервис недоступен' };
	}
}

const docparseHealth = z.object({
	status: z.literal('ok'),
	extractor: z.object({ name: z.string(), version: z.string() }),
	formats: z.array(z.string())
});
const sandboxVersion = z.object({ buildVersion: z.string().min(1) });
const oidcDiscovery = z.object({ issuer: z.string().min(1) });

export interface IntegrationsState {
	database: 'up' | 'down';
	redis: 'up' | 'down';
	docparse: { url: string; probe: Probe };
	sandbox: { url: string; maxConcurrentRuns: number; probe: Probe };
	fspId: { issuer: string; clientId: string; scopes: string; probe: Probe } | null;
	fspAchievements: {
		adapter: 'mock' | 'fsp-api';
		host: string;
		lastWebhookAt: Date | null;
		activeAthleteLinks: number;
	} | null;
	telegram: { botUsername: string; activeChannels: number } | null;
}

export async function integrationsState(deps: IntegrationsDeps, ctx: ActionContext): Promise<IntegrationsState> {
	requirePermission(ctx.subject, 'jobs.manage', null);
	const { config } = deps;
	const docparseUrl = config.docparse.url.replace(/\/+$/, '');
	const sandboxUrl = config.sandbox.url.replace(/\/+$/, '');
	const fspIdConfig = config.fspId;
	const achievements = config.fspAchievements;
	const [health, docparse, sandbox, fspIdProbe, lastWebhook, athletes, telegramChannels] = await Promise.all([
		deps.health(),
		probe('docparse', deps, `${docparseUrl}/v1/health`, docparseHealth, (body) => body.extractor.version),
		probe('sandbox', deps, `${sandboxUrl}/version`, sandboxVersion, (body) => `go-judge ${body.buildVersion}`),
		fspIdConfig
			? probe(
					'fsp-id',
					deps,
					`${fspIdConfig.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
					oidcDiscovery,
					() => 'описание провайдера получено'
				)
			: null,
		deps.db
			.select({ at: max(inboundEvents.receivedAt) })
			.from(inboundEvents)
			.where(eq(inboundEvents.source, 'fsp')),
		deps.db
			.select({ n: count() })
			.from(athleteLinks)
			.where(
				and(eq(athleteLinks.source, 'fsp'), eq(athleteLinks.status, 'active'), isNull(athleteLinks.demoSessionId))
			),
		deps.db
			.select({ n: count() })
			.from(notificationChannels)
			.where(and(eq(notificationChannels.kind, 'telegram'), eq(notificationChannels.status, 'active')))
	]);
	return {
		database: health.checks.database,
		redis: health.checks.redis,
		docparse: { url: docparseUrl, probe: docparse },
		sandbox: { url: sandboxUrl, maxConcurrentRuns: config.sandbox.maxConcurrentRuns, probe: sandbox },
		fspId:
			fspIdConfig && fspIdProbe
				? {
						issuer: fspIdConfig.issuer,
						clientId: fspIdConfig.clientId,
						scopes: fspIdConfig.scopes,
						probe: fspIdProbe
					}
				: null,
		fspAchievements: achievements
			? {
					adapter: achievements.adapter,
					host: new URL(achievements.baseUrl).host,
					lastWebhookAt: lastWebhook[0]?.at ?? null,
					activeAthleteLinks: athletes[0]?.n ?? 0
				}
			: null,
		telegram: config.telegram
			? { botUsername: config.telegram.botUsername, activeChannels: telegramChannels[0]?.n ?? 0 }
			: null
	};
}
