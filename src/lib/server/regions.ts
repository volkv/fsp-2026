// The reference of regions (`seeds/regions.json`, shipped with the application): the subjects of the Russian Federation
// by name with their codes. A candidate states one of them (`preferences.region_code`), an employer filters the catalog
// by them, the demo seed gives its candidates regions by name from it. Every stored or queried code is one of these.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const regionsFileSchema = z.strictObject({
	description: z.string(),
	/** Region names to codes: ISO 3166-2:RU where the standard has one. */
	regions: z.record(z.string().min(1), z.string().regex(/^RU-[A-Z]{2,3}$/))
});

export interface Region {
	code: string;
	name: string;
}

/** The regions of one reference file, by name, with lookups by code and by name. */
export class RegionReference {
	/** Sorted by name, as a picker lists them. */
	readonly regions: readonly Region[];
	private readonly byCode: ReadonlyMap<string, Region>;
	private readonly byName: ReadonlyMap<string, Region>;

	constructor(file: z.infer<typeof regionsFileSchema>) {
		const regions = Object.entries(file.regions)
			.map(([name, code]) => ({ code, name }))
			.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
		const byCode = new Map<string, Region>();
		for (const region of regions) {
			const other = byCode.get(region.code);
			if (other) throw new Error(`regions «${other.name}» and «${region.name}» share the code ${region.code}`);
			byCode.set(region.code, region);
		}
		this.regions = regions;
		this.byCode = byCode;
		this.byName = new Map(regions.map((region) => [region.name, region]));
	}

	has(code: string): boolean {
		return this.byCode.has(code);
	}

	/** The name of a known code; `undefined` — the reference does not know it. */
	name(code: string): string | undefined {
		return this.byCode.get(code)?.name;
	}

	/** The code of a region by its exact name; `undefined` — the reference does not know it. */
	codeOf(name: string): string | undefined {
		return this.byName.get(name)?.code;
	}
}

/** `seeds/regions.json` of the working directory: the repository root in development, `/app` in the image. */
const regionsPath = () => resolve(process.cwd(), 'seeds', 'regions.json');

let loaded: Promise<RegionReference> | undefined;

async function load(): Promise<RegionReference> {
	const path = regionsPath();
	const parsed = regionsFileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
	if (!parsed.success) throw new Error(`${path} does not match its schema: ${z.prettifyError(parsed.error)}`);
	return new RegionReference(parsed.data);
}

/** The reference of the application, read once. A failed read is not kept: the next call reads the file again. */
export function regionReference(): Promise<RegionReference> {
	if (loaded === undefined) {
		loaded = load();
		loaded.catch(() => {
			loaded = undefined;
		});
	}
	return loaded;
}

/** The name of a stored code. Codes are checked against the reference when stored, so an unknown one is a defect. */
export async function regionName(code: string): Promise<string> {
	const name = (await regionReference()).name(code);
	if (name === undefined) throw new Error(`region ${code} is not in the reference of regions`);
	return name;
}
