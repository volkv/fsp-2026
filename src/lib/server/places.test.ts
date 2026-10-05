// Places a text names → regions: a city in any case, a region by its name, an ambiguous city only with a word of place.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PlaceReference, citiesFileSchema } from './places';
import { RegionReference, regionsFileSchema } from './regions';

const read = async (name: string): Promise<unknown> =>
	JSON.parse(await readFile(new URL(`../../../seeds/${name}`, import.meta.url), 'utf8'));
const regions = new RegionReference(regionsFileSchema.parse(await read('regions.json')));
const places = new PlaceReference(citiesFileSchema.parse(await read('cities.json')), regions);
const region = (text: string) => places.find(text)?.regionCode ?? null;

describe('places of a text', () => {
	it.each([
		['Казань', 'RU-TA'],
		['Офис в Казани, гибрид', 'RU-TA'],
		['Работа в Нижнем Новгороде', 'RU-NIZ'],
		['Локация: Санкт-Петербург', 'RU-SPE'],
		['офис в Набережных Челнах', 'RU-TA'],
		['гибрид, Екатеринбург', 'RU-SVE'],
		['в Ростове-на-Дону', 'RU-ROS'],
		['Иннополис, удалённо можно', 'RU-TA'],
		['г. Владимир', 'RU-VLA'],
		['ищем в Уфе', 'RU-BA'],
		['офис в Сочи', 'RU-KDA'],
		['в Улан-Удэ', 'RU-BU'],
		['офис в Кирове', 'RU-KIR'],
		['Город: Орёл', 'RU-ORL'],
		['Республика Татарстан', 'RU-TA'],
		['Москва или Санкт-Петербург', 'RU-MOW']
	])('%s → %s', (text, code) => {
		expect(region(text)).toBe(code);
	});

	it.each([
		'Контакт: Владимир, рекрутер',
		'Нужен опыт с Kotlin',
		'Московская кухня, стартап',
		'Пишите Ивану Иванову',
		'Удалённо по всей России',
		'Сочный проект на Go'
	])('names no place in «%s»', (text) => {
		expect(region(text)).toBeNull();
	});

	it('names only regions of the reference', () => {
		expect(
			() =>
				new PlaceReference(
					{ description: '', cities: { Атлантида: 'RU-XX' }, ambiguous: [], indeclinable: [] },
					regions
				)
		).toThrow(/RU-XX/u);
	});
});
