// What the public API works with: the configured infrastructure, built lazily so that `vite build` needs no
// environment. Route files serve operations with `apiServices()`; tests pass their own services.
import type { AuthDeps } from '$lib/server/auth/context';
import { configuredRegistry, type CompanyRegistry } from '$lib/server/companies/registry';
import type { CompanyDeps } from '$lib/server/companies/context';
import { config } from '$lib/server/config';
import { fieldCrypto, type FieldCrypto } from '$lib/server/crypto/fields';
import { db, type Database } from '$lib/server/db';
import { configuredReceiptSigner, type ReceiptSigner } from '$lib/server/fsp/receipts';
import type { InvitationDeps } from '$lib/server/invitations/deps';
import { mailer, type Mailer } from '$lib/server/mail/mailer';
import type { MatchingDeps } from '$lib/server/matching/deps';
import type { MatchingModels } from '$lib/server/matching/semantic';
import { GRADE_DECISION_RESULTS, type TestResultReader } from '$lib/server/matching/test-results';
import { modelAdapter } from '$lib/server/ml';
import type { NeedDeps } from '$lib/server/needs/service';
import type { ApplicationDeps } from '$lib/server/applications/service';
import type { ChallengeDeps } from '$lib/server/challenges/company';
import type { ConfirmationDeps } from '$lib/server/confirmations/requests';
import type { ShortlistDeps } from '$lib/server/shortlists/service';
import type { ModelAdapter } from '$lib/server/ml/adapter';
import { redis, type Redis } from '$lib/server/redis';
import type { ResumeDeps } from '$lib/server/resumes/deps';
import { objectStore, type ObjectStore } from '$lib/server/storage/object-store';
import { redisTextParseCache } from '$lib/server/vacancies/text-extract';

export interface ApiServices {
	db: Database;
	/** Connected Redis: stored answers of idempotent requests. */
	redis: () => Promise<Redis>;
	crypto: FieldCrypto;
	mailer: Mailer;
	/** The bucket of uploaded files: resumes. */
	store: ObjectStore;
	registry: CompanyRegistry;
	models: MatchingModels & Pick<ModelAdapter, 'extract'>;
	/** Signs the receipts of facts a catalog card issues. */
	receiptSigner: ReceiptSigner;
	/** Origin of links in letters. */
	appOrigin: string;
	/** Results of the test by blocks for the ranking of shortlists and the catalog (domain 13.10). */
	testResults: TestResultReader;
	now: () => Date;
}

let configured: ApiServices | undefined;

export function apiServices(): ApiServices {
	configured ??= {
		db: db(),
		redis,
		crypto: fieldCrypto(),
		mailer: mailer(),
		store: objectStore(),
		registry: configuredRegistry(config().companyRegistry),
		models: modelAdapter(),
		receiptSigner: configuredReceiptSigner(),
		appOrigin: config().appOrigin,
		testResults: GRADE_DECISION_RESULTS,
		now: () => new Date()
	};
	return configured;
}

export const companyDeps = (s: ApiServices): CompanyDeps => ({
	db: s.db,
	crypto: s.crypto,
	mailer: s.mailer,
	registry: s.registry,
	appOrigin: s.appOrigin,
	now: s.now
});

export const invitationDeps = (s: ApiServices): InvitationDeps => ({
	db: s.db,
	crypto: s.crypto,
	now: s.now
});

export const needDeps = (s: ApiServices): NeedDeps => ({
	db: s.db,
	models: s.models,
	parseCache: redisTextParseCache(s.redis),
	now: s.now
});

export const matchingDeps = (s: ApiServices): MatchingDeps => ({
	db: s.db,
	models: s.models,
	pseudonym: (candidateId, companyId) => s.crypto.pseudonym(candidateId, companyId),
	now: s.now,
	testResults: s.testResults
});

export const shortlistDeps = (s: ApiServices): ShortlistDeps => ({ ...matchingDeps(s), db: s.db });

/** Requests of a confirmation, calls of companies and applications (domain 13.11, 13.12, 13.5). */
export const contactDeps = (s: ApiServices): ConfirmationDeps & ChallengeDeps & ApplicationDeps => ({
	db: s.db,
	crypto: s.crypto,
	now: s.now
});

export const resumeApiDeps = (s: ApiServices): ResumeDeps => ({ db: s.db, store: s.store, now: s.now });

/** The sign-in module: consents signed at sign-up and the deletion of the account (domain 3.4, 6.2). */
export const authDepsOf = async (s: ApiServices): Promise<AuthDeps> => ({
	db: s.db,
	redis: await s.redis(),
	crypto: s.crypto,
	mailer: s.mailer,
	appOrigin: s.appOrigin,
	now: s.now
});
