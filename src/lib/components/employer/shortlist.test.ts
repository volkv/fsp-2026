import { describe, expect, it } from 'vitest';
import { reasonText, type ReasonData } from './shortlist';

const NAMES = { skills: {}, roles: {}, specializations: {}, grades: {}, workFormats: {}, blocks: {} };
const RECORD: ReasonData = {
	code: 'fsp_record',
	competitions: 2,
	podiums: 1,
	team_podiums: 1,
	relevant: null,
	contribution: 0.05,
	source: { kind: 'fsp_fact' }
};

describe('source of the FSP record', () => {
	it('names the simulator of a demonstration stand, not the official protocols', () => {
		expect(reasonText(RECORD, NAMES, { fspSimulator: true }).source).toBe(
			'протоколы ФСП (в прототипе — из имитатора) — квитанции в карточке'
		);
	});

	it('names the official protocols of FSP on a platform fed by the federation', () => {
		expect(reasonText(RECORD, NAMES, { fspSimulator: false }).source).toBe(
			'официальные протоколы ФСП — квитанции в карточке'
		);
	});
});
