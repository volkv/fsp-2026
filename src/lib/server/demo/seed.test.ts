import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readSeedData, type SeedData } from './data';
import { batchId, reconsentVersions, type PublishedDocumentVersion } from './seed';
import type { DemoServices } from './services';

const settings: DemoServices['settings'] = {
	candidates: 1000,
	vacancies: 300,
	nightlyReset: true,
	review: false,
	seedModel: 'stored',
	world: { seed: 'test', athletes: 3000 },
	fspMockControlToken: 'token'
};
const releases = ['backend@2026.10.3-1'];

const published: PublishedDocumentVersion[] = [
	{ kind: 'user_agreement', version: 1, requiresReconsent: false },
	{ kind: 'pd_processing', version: 1, requiresReconsent: false },
	{ kind: 'catalog_visibility', version: 1, requiresReconsent: true }
];

let data: SeedData;
const batchOf = (documents: readonly PublishedDocumentVersion[]) =>
	batchId(data, settings, releases, reconsentVersions(documents));

beforeAll(async () => {
	data = await readSeedData(resolve(import.meta.dirname, '../../../../seeds'));
});

describe('demo batch and the legal documents', () => {
	it('is a new batch when a document asking for consent again is published anew', () => {
		const republished: PublishedDocumentVersion[] = [
			...published,
			{ kind: 'catalog_visibility', version: 2, requiresReconsent: true }
		];
		expect(batchOf(republished)).not.toBe(batchOf(published));
	});

	it('keeps the batch when a new version keeps the given consents', () => {
		const republished: PublishedDocumentVersion[] = [
			...published,
			{ kind: 'user_agreement', version: 2, requiresReconsent: false },
			{ kind: 'catalog_visibility', version: 2, requiresReconsent: false }
		];
		expect(batchOf(republished)).toBe(batchOf(published));
	});
});
