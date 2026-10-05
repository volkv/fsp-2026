// Places a text names → regions of the reference (`seeds/cities.json` over `seeds/regions.json`): a need written as
// «офис в Казани» stands for the region the candidate states in the questionnaire, Республика Татарстан. A city is read
// in any case («в Казани», «Нижнем Новгороде», «Набережных Челнах»), a region by its name as the reference writes it.
// A city whose name is also a first name, a surname or a word («Владимир», «Орёл», «Шахты») counts only with a word of
// place before it: «в Кирове», «г. Владимир», «Город: Орёл».
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { regionReference, type RegionReference } from './regions';

export const citiesFileSchema = z.strictObject({
	description: z.string(),
	/** City names, as written, to region codes of `seeds/regions.json`. */
	cities: z.record(z.string().min(2), z.string().regex(/^RU-[A-Z]{2,3}$/)),
	/** Cities read only with a word of place before them. */
	ambiguous: z.array(z.string().min(2)),
	/** Cities whose name does not change by case («Сочи»): read only as written. */
	indeclinable: z.array(z.string().min(2))
});

export interface PlaceFound {
	/** The city or the region as the reference names it. */
	name: string;
	regionCode: string;
	/** Where the name stands in the text. */
	start: number;
	end: number;
}

const foldYo = (text: string) => text.replaceAll('ё', 'е').replaceAll('Ё', 'Е');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A city name in any case: every part longer than three letters drops its ending vowels or soft sign and takes up to
 * three letters of an ending («Казань» — «Казани», «Нижний Новгород» — «Нижнем Новгороде», «Набережные Челны» —
 * «Набережных Челнах»); parts of two letters («на») stay as written, three-letter ones («Уфа») change only their last vowel. A vowel that drops inside the word («Орёл» — «Орле»)
 * is not read.
 */
function inflected(name: string): string {
	return foldYo(name)
		.split(/(\s+|-)/u)
		.map((part) => {
			if (/^\s+$/u.test(part)) return '\\s+';
			if (part === '-') return '-';
			if (part.length < 3) return escape(part);
			// «Уфа» — «Уфе», «Уфой»: a short name keeps its consonants and changes only its last vowel.
			if (part.length === 3) return /[ауэ]$/u.test(part) ? `${escape(part.slice(0, 2))}\\p{Ll}{1,2}` : escape(part);
			return `${escape(part.replace(/[аяьйыиеоэ]{1,2}$/u, ''))}\\p{Ll}{0,3}`;
		})
		.join('');
}

/** A word of place right before a name: «в», «во», «из», «г.», «город», «Город:», «Офис:». */
const PLACE_WORD =
	/(?:(?<![\p{L}])(?:в|во|из|под|г\.?|город\p{L}*)\s*|(?:город|локация|location|офис|местоположение)\s*:\s*)$/iu;

export class PlaceReference {
	private readonly patterns: { name: string; regionCode: string; pattern: RegExp; ambiguous: boolean }[];

	constructor(file: z.infer<typeof citiesFileSchema>, regions: RegionReference) {
		for (const [city, code] of Object.entries(file.cities)) {
			if (!regions.has(code)) throw new Error(`city «${city}» names the region ${code} not in seeds/regions.json`);
		}
		for (const city of [...file.ambiguous, ...file.indeclinable]) {
			if (file.cities[city] === undefined) throw new Error(`city «${city}» of a list is not among the cities`);
		}
		const ambiguous = new Set(file.ambiguous);
		const indeclinable = new Set(file.indeclinable);
		const cities = Object.entries(file.cities).map(([name, regionCode]) => ({
			name,
			regionCode,
			pattern: new RegExp(
				`(?<![\\p{L}-])${indeclinable.has(name) ? escape(foldYo(name)) : inflected(name)}(?![\\p{L}-])`,
				'gu'
			),
			ambiguous: ambiguous.has(name)
		}));
		const regionNames = regions.regions.map((region) => ({
			name: region.name,
			regionCode: region.code,
			pattern: new RegExp(`(?<![\\p{L}])${escape(foldYo(region.name))}(?![\\p{L}])`, 'giu'),
			ambiguous: false
		}));
		// The longest names first: «Нижний Новгород» before a shorter name inside it.
		this.patterns = [...regionNames, ...cities].sort((a, b) => b.name.length - a.name.length);
	}

	/** The first place the text names, by its position; `null` — none. */
	find(text: string): PlaceFound | null {
		const folded = foldYo(text);
		let found: PlaceFound | null = null;
		for (const { name, regionCode, pattern, ambiguous } of this.patterns) {
			pattern.lastIndex = 0;
			for (let match = pattern.exec(folded); match !== null; match = pattern.exec(folded)) {
				if (ambiguous && !PLACE_WORD.test(folded.slice(0, match.index))) continue;
				if (found === null || match.index < found.start) {
					found = { name, regionCode, start: match.index, end: match.index + match[0].length };
				}
				break;
			}
		}
		return found;
	}
}

/** `seeds/cities.json` of the working directory: the repository root in development, `/app` in the image. */
const citiesPath = () => resolve(process.cwd(), 'seeds', 'cities.json');

let loaded: Promise<PlaceReference> | undefined;

async function load(): Promise<PlaceReference> {
	const path = citiesPath();
	const parsed = citiesFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
	if (!parsed.success) throw new Error(`${path} does not match its schema: ${z.prettifyError(parsed.error)}`);
	return new PlaceReference(parsed.data, await regionReference());
}

/** The reference of places of the application, read once; a failed read is not kept. */
export function placeReference(): Promise<PlaceReference> {
	if (loaded === undefined) {
		loaded = load();
		loaded.catch(() => {
			loaded = undefined;
		});
	}
	return loaded;
}
