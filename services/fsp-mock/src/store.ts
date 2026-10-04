// In-memory dataset of the simulator. Every change of an athlete's data bumps that athlete's revision, which is part
// of `sourceVersion`: pages served before and after a change carry different versions.

import type { Account, AccountDirectory, DemoAccount } from './accounts.ts';
import type { Athlete, Competition, Qualification, Result } from './types.ts';

export interface AthleteRecord {
	athlete: Athlete;
	results: Result[];
	qualifications: Qualification[];
	revision: number;
}

export interface World {
	/** Short hash of the generator input: a different seed or size gives a different id. */
	datasetId: string;
	/** Date the generated history ends at: later competitions have no results yet. */
	asOf: string;
	competitions: Map<string, Competition>;
	athletes: Map<string, AthleteRecord>;
	accounts: Map<string, Account>;
	demo: DemoAccount[];
}

export class Store implements AccountDirectory {
	#world: World;
	#resultOwner = new Map<string, string>();
	readonly #generate: () => World;

	constructor(generate: () => World) {
		this.#generate = generate;
		this.#world = generate();
		this.#index();
	}

	get world(): World {
		return this.#world;
	}

	/** Regenerates the dataset from the seed, dropping every change made through the control endpoints. */
	reset(): void {
		this.#world = this.#generate();
		this.#index();
	}

	#index(): void {
		this.#resultOwner = new Map();
		for (const [fspId, record] of this.#world.athletes) {
			for (const result of record.results) this.#resultOwner.set(result.id, fspId);
		}
	}

	get(sub: string): Account | undefined {
		return this.#world.accounts.get(sub);
	}

	search(query: string, limit: number, excluded: ReadonlySet<string>): Account[] {
		const needle = query.trim().toLowerCase();
		if (needle === '') return [];
		const found: Account[] = [];
		for (const account of this.#world.accounts.values()) {
			if (excluded.has(account.sub)) continue;
			const haystack =
				`${account.familyName} ${account.givenName} ${account.preferredUsername} ${account.sub}`.toLowerCase();
			if (haystack.includes(needle)) found.push(account);
			if (found.length >= limit) break;
		}
		return found;
	}

	demo(): readonly DemoAccount[] {
		return this.#world.demo;
	}

	athlete(fspId: string): AthleteRecord | undefined {
		return this.#world.athletes.get(fspId);
	}

	competition(id: string): Competition | undefined {
		return this.#world.competitions.get(id);
	}

	sourceVersion(record: AthleteRecord): string {
		return `${this.#world.datasetId}.${record.revision}`;
	}

	/** Owner of a result record, or undefined. */
	findResult(resultId: string): { record: AthleteRecord; result: Result } | undefined {
		const owner = this.#resultOwner.get(resultId);
		const record = owner === undefined ? undefined : this.#world.athletes.get(owner);
		const result = record?.results.find((r) => r.id === resultId);
		return record && result ? { record, result } : undefined;
	}

	replaceResult(record: AthleteRecord, result: Result): void {
		const index = record.results.findIndex((r) => r.id === result.id);
		if (index === -1) throw new Error(`result ${result.id} does not belong to ${record.athlete.fspId}`);
		record.results[index] = result;
		record.revision += 1;
	}

	addResult(record: AthleteRecord, result: Result): void {
		if (this.#resultOwner.has(result.id)) throw new Error(`result ${result.id} already exists`);
		record.results.push(result);
		this.#resultOwner.set(result.id, record.athlete.fspId);
		record.revision += 1;
	}

	removeResult(record: AthleteRecord, resultId: string): void {
		record.results = record.results.filter((r) => r.id !== resultId);
		this.#resultOwner.delete(resultId);
		record.revision += 1;
	}

	addQualification(record: AthleteRecord, qualification: Qualification): void {
		record.qualifications.push(qualification);
		record.revision += 1;
	}

	/** Records a change made outside the result list (e.g. a simulated concurrent update). */
	touch(record: AthleteRecord): void {
		record.revision += 1;
	}
}
