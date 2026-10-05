// Requirements the taxonomy does not know are kept by name; negations, prose and recognized skills are not.
import { describe, expect, it } from 'vitest';
import { unrecognizedRequirements } from './requirements';

const blocks = (...lines: string[]) => lines.map((text, index) => ({ id: `b${index}`, text }));
const names = (lines: string[], recognized: string[]) =>
	unrecognizedRequirements(blocks(...lines), recognized).map((r) => [r.name, r.requirement]);

describe('requirements outside the taxonomy', () => {
	it('keeps a listed tool no alias names, required or nice by the lead of its line', () => {
		expect(names(['ML-инженер', 'Требования: Python, Hugging Face, Docker.'], ['Python', 'Docker'])).toEqual([
			['Hugging Face', 'required']
		]);
		expect(names(['Будет плюсом: Airflow и dbt'], ['Airflow'])).toEqual([['dbt', 'nice']]);
		expect(names(['Обязательно: опыт с ClickHouse'], [])).toEqual([['ClickHouse', 'required']]);
		expect(names(['Стек — 1С, Битрикс'], [])).toEqual([
			['1С', 'required'],
			['Битрикс', 'required']
		]);
	});

	it('skips what the text negates, prose, years and lines without a list of requirements', () => {
		expect(names(['Kotlin не требуется'], [])).toEqual([]);
		expect(names(['Требования: Python, без 1С'], ['Python'])).toEqual([]);
		expect(names(['Требования: опыт от 3 лет, умение писать тесты'], [])).toEqual([]);
		expect(names(['Мы делаем платформу для моделей Hugging Face'], [])).toEqual([]);
		expect(names(['Желательно: понимание принципов ООП'], [])).toEqual([]);
	});

	it('treats a recognized mention inside an item as that skill', () => {
		expect(names(['Нужен опыт с PostgreSQL 14'], ['PostgreSQL'])).toEqual([]);
	});
});
