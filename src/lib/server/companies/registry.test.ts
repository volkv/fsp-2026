import { describe, expect, it } from 'vitest';
import { egrulRegistry, nameMatches, normalizeCompanyName, type RegistryRecord } from './registry';
import { innKind, isValidKpp, isValidOgrn } from './requisites';

const SBER_ROW = {
	c: 'ПАО СБЕРБАНК',
	g: 'ПРЕЗИДЕНТ, ПРЕДСЕДАТЕЛЬ ПРАВЛЕНИЯ: Иванов Иван Иванович',
	i: '7707083893',
	k: 'ul',
	n: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"',
	o: '1027700132195',
	p: '773601001',
	r: '16.08.2002',
	rn: 'Г.Москва'
};

/** A fake of the two-step search: the form returns a token, the result is read by it. */
function fakeEgrul(result: unknown, start: unknown = { t: 'ABC123', captchaRequired: false }) {
	const calls: string[] = [];
	const fetchImpl = ((input: string | URL | Request) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push(url);
		const body = url.endsWith('/') ? start : result;
		return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
	}) as typeof fetch;
	return { registry: egrulRegistry({ fetch: fetchImpl, baseUrl: 'https://egrul.test', pollDelayMs: 1 }), calls };
}

describe('egrul registry', () => {
	it('returns the record whose number equals the query', async () => {
		const { registry, calls } = fakeEgrul({ rows: [{ ...SBER_ROW, i: '7707083894' }, SBER_ROW] });
		const lookup = await registry.lookup('7707083893');
		expect(lookup.status).toBe('found');
		if (lookup.status !== 'found') return;
		expect(lookup.record).toMatchObject({
			inn: '7707083893',
			kind: 'organization',
			ogrn: '1027700132195',
			kpp: '773601001',
			registeredOn: '2002-08-16',
			endedOn: null,
			region: 'Г.Москва'
		});
		expect(calls).toEqual(['https://egrul.test/', 'https://egrul.test/search-result/ABC123']);
	});

	it('marks a liquidated entity by its end date', async () => {
		const { registry } = fakeEgrul({ rows: [{ ...SBER_ROW, e: '01.02.2020' }] });
		const lookup = await registry.lookup('7707083893');
		expect(lookup.status === 'found' && lookup.record.endedOn).toBe('2020-02-01');
	});

	it('says not found when no row carries the number', async () => {
		const { registry } = fakeEgrul({ rows: [] });
		expect(await registry.lookup('7707083893')).toEqual({ status: 'not_found', source: 'egrul' });
	});

	it('is unavailable when the source asks for a captcha, answers with an error or garbage', async () => {
		expect(await fakeEgrul({ rows: [] }, { captchaRequired: true }).registry.lookup('7707083893')).toEqual({
			status: 'unavailable',
			source: 'egrul',
			reason: 'captcha'
		});
		expect(await fakeEgrul({ unexpected: true }).registry.lookup('7707083893')).toEqual({
			status: 'unavailable',
			source: 'egrul',
			reason: 'malformed'
		});
		const failing = egrulRegistry({
			fetch: () => Promise.resolve(new Response('busy', { status: 503 })),
			baseUrl: 'https://egrul.test'
		});
		expect(await failing.lookup('7707083893')).toEqual({
			status: 'unavailable',
			source: 'egrul',
			reason: 'http_status'
		});
	});

	it('does not query the source for a number with wrong check digits', async () => {
		const { registry, calls } = fakeEgrul({ rows: [SBER_ROW] });
		expect((await registry.lookup('7707083894')).status).toBe('not_found');
		expect(calls).toEqual([]);
	});
});

describe('company names', () => {
	const record: RegistryRecord = {
		inn: '7707083893',
		kind: 'organization',
		name: 'ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "СБЕРБАНК РОССИИ"',
		shortName: 'ПАО СБЕРБАНК',
		ogrn: null,
		kpp: null,
		registeredOn: null,
		endedOn: null,
		head: null,
		region: null
	};

	it('ignores quotes, case and the legal form', () => {
		expect(normalizeCompanyName('ООО «Ромашка»')).toBe('РОМАШКА');
		expect(normalizeCompanyName('Общество с ограниченной ответственностью "Ромашка"')).toBe('РОМАШКА');
		expect(nameMatches('Сбербанк', record)).toBe(true);
		expect(nameMatches('ПАО «Сбербанк России»', record)).toBe(true);
		expect(nameMatches('Ромашка', record)).toBe(false);
	});
});

describe('requisites', () => {
	it('checks ИНН, ОГРН and КПП locally', () => {
		expect(innKind('7707083893')).toBe('organization');
		expect(innKind('500100732259')).toBe('entrepreneur');
		expect(innKind('7707083894')).toBeNull();
		expect(isValidOgrn('1027700132195')).toBe(true);
		expect(isValidOgrn('1027700132196')).toBe(false);
		expect(isValidOgrn('304500116000157')).toBe(true);
		expect(isValidKpp('773601001')).toBe(true);
		expect(isValidKpp('77360100')).toBe(false);
	});
});
