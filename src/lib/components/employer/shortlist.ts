/**
 * Wording of a shortlist (docs/domain.md, section 13.10): the reasons «почему подходит» with their sources and exact
 * contributions, the basis of each skill of the need, the second axis «подходит ли предложение кандидату», the changes
 * of the steps and the answers of «что если». The page receives plain data; nothing here reaches the server.
 */

export interface ShortlistNames {
	skills: Readonly<Record<string, string>>;
	roles: Readonly<Record<string, string>>;
	specializations: Readonly<Record<string, string>>;
	grades: Readonly<Record<string, string>>;
	workFormats: Readonly<Record<string, string>>;
	blocks: Readonly<Record<string, string>>;
}

export interface ReasonData {
	code: string;
	skill_keys?: string[];
	specialization?: string;
	grade?: string;
	margin?: number;
	format?: string;
	days?: number;
	contribution: number;
	source: { kind: string; ref?: string; specialization?: string; grade?: string };
}

export interface ComponentData {
	level: 'need' | 'strength';
	applicable: boolean;
	status: 'computed' | 'unknown' | 'unavailable';
	value: number;
	weight: number;
	contribution: number;
	reason: string | null;
}

export interface CoverageData {
	group: 'covers' | 'gaps';
	required: number;
	unconfirmed: { skill_key: string; state: 'public_profile' | 'claimed' | 'missing' | 'unknown' }[];
}

export interface NeedMatchData {
	coverage: CoverageData;
	composite: { specializations: string[]; held: string[]; complete: boolean } | null;
	score: number;
	levels: { need: number; strength: number };
	components: Record<string, ComponentData>;
	skills: { skill_key: string; requirement: 'required' | 'nice'; basis: string; value: number; block: string | null }[];
	reasons: ReasonData[];
	gaps: string[];
	toVerify: string[];
	category: { specialization: string; grade: string } | null;
	semantic: number | null;
	tieBrokenBySemantic: boolean;
	position: number;
	positionWithoutFsp: number;
}

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3, minimumFractionDigits: 3 });

/** A contribution as the page shows it: «+0,124». */
export function contribution(value: number): string {
	return `+${number.format(value)}`;
}

const list = (keys: readonly string[] | undefined, names: Readonly<Record<string, string>>) =>
	(keys ?? []).map((key) => names[key] ?? key).join(', ');

export function categoryName(category: { specialization: string; grade: string }, names: ShortlistNames): string {
	return `${names.specializations[category.specialization] ?? category.specialization} · ${names.grades[category.grade] ?? category.grade}`;
}

/** The text of a reason and where it comes from. */
export function reasonText(reason: ReasonData, names: ShortlistNames): { text: string; source: string } {
	const block = reason.source.ref ? (names.blocks[reason.source.ref] ?? reason.source.ref) : '';
	const of =
		reason.source.specialization && reason.source.grade
			? categoryName({ specialization: reason.source.specialization, grade: reason.source.grade }, names)
			: '';
	switch (reason.code) {
		case 'skills_test':
			return { text: `Тест подтвердил: ${list(reason.skill_keys, names.skills)}`, source: `блок «${block}», ${of}` };
		case 'skills_fsp':
			return {
				text: `Результат ФСП подтверждает: ${list(reason.skill_keys, names.skills)}`,
				source: 'квитанция ФСП в карточке'
			};
		case 'skills_platform':
			return { text: `Подтверждено платформой: ${list(reason.skill_keys, names.skills)}`, source: 'факт платформы' };
		case 'skills_public_profile':
			return {
				text: `Публичный профиль показывает: ${list(reason.skill_keys, names.skills)}`,
				source: 'проверенный публичный профиль'
			};
		case 'skills_claimed_untestable':
			return {
				text: `Заявлено, тестом не проверяется: ${list(reason.skill_keys, names.skills)}`,
				source: 'опыт в резюме, не проверено'
			};
		case 'skills_claimed':
			return { text: `Заявлено: ${list(reason.skill_keys, names.skills)}`, source: 'профиль кандидата, не проверено' };
		case 'test_result': {
			const margin = reason.margin ?? 0;
			const words = margin > 0.05 ? 'уверенно выше порога' : margin > 0 ? 'выше порога' : 'на пороге';
			return { text: `Результат теста ${of}: ${words}`, source: `сильнее всего — блок «${block}»` };
		}
		case 'fsp_related':
			return {
				text: `ФСП относится к потребности: ${list(reason.skill_keys, names.skills)}`,
				source: 'квитанция ФСП в карточке'
			};
		case 'format_fits':
			return {
				text: `Формат подходит: ${names.workFormats[reason.format ?? ''] ?? reason.format ?? ''}`,
				source: 'предпочтения в карточке'
			};
		case 'confirmed_recently':
			return { text: `Категория подтверждена ${reason.days ?? 0} дн. назад`, source: `тест ${of}` };
		default:
			return { text: reason.code, source: '' };
	}
}

export const BASIS: Record<string, { label: string; tone: string }> = {
	test: { label: 'тест', tone: 'bg-trust-platform text-trust-platform-foreground' },
	fsp: { label: 'ФСП', tone: 'bg-trust-fsp text-trust-fsp-foreground' },
	platform: { label: 'платформа', tone: 'bg-trust-platform text-trust-platform-foreground' },
	public_profile: { label: 'публичный профиль', tone: 'bg-trust-public text-trust-public-foreground' },
	claimed_untestable: {
		label: 'заявлено, тестом не проверяется',
		tone: 'border border-dashed border-trust-claimed-border text-trust-claimed-foreground'
	},
	claimed: {
		label: 'заявлено',
		tone: 'border border-dashed border-trust-claimed-border text-trust-claimed-foreground'
	},
	missing: { label: 'нет', tone: 'border border-dashed text-muted-foreground line-through' },
	unknown: { label: 'неизвестно: профиль пересчитывается', tone: 'border border-dashed text-muted-foreground' }
};

const UNCONFIRMED: Record<CoverageData['unconfirmed'][number]['state'], string> = {
	public_profile: 'только публичный профиль',
	claimed: 'заявлено',
	missing: 'нет',
	unknown: 'неизвестно — профиль пересчитывается'
};

/** «Не подтверждено 2 из 3 обязательных: Docker — заявлено, Kafka — нет»; `null` — всё подтверждено. */
export function coverageText(coverage: CoverageData, names: ShortlistNames): string | null {
	if (coverage.unconfirmed.length === 0) return null;
	const items = coverage.unconfirmed.map(
		(item) => `${names.skills[item.skill_key] ?? item.skill_key} — ${UNCONFIRMED[item.state]}`
	);
	return `Не подтверждено ${coverage.unconfirmed.length} из ${coverage.required} обязательных: ${items.join(', ')}`;
}

/** «Составная роль: подтверждены Backend и Frontend» or «…: подтверждена только Backend»; `null` — the role is not composite. */
export function compositeText(composite: NeedMatchData['composite'], names: ShortlistNames): string | null {
	if (composite === null) return null;
	const held = composite.held.map((key) => names.specializations[key] ?? key);
	if (composite.complete) return `Составная роль: подтверждены обе категории — ${held.join(' и ')}`;
	return `Составная роль: подтверждена только ${held.join(', ') || 'другая категория'}`;
}

/** The heading of a group of the ranking. */
export function groupTitle(coverage: CoverageData): string {
	if (coverage.group === 'covers') return 'Закрывают все обязательные требования';
	const n = coverage.unconfirmed.length;
	return `Категория подходит, не подтверждено ${n} из ${coverage.required} обязательных`;
}

export const COMPONENT_NAMES: Record<string, string> = {
	required: 'Обязательные навыки',
	nice: 'Желательные навыки',
	format: 'Формат и регион',
	test: 'Результат теста по блокам',
	fsp: 'ФСП, относящийся к потребности',
	freshness: 'Свежесть подтверждения'
};

export const COMPONENT_REASONS: Record<string, string> = {
	test_result_missing: 'результат теста по блокам не найден — засчитано на пороге',
	no_related_fsp: 'нет ФСП по навыкам потребности: бонуса нет, штрафа нет',
	without_fsp: 'без ФСП',
	need_fsp_not_relevant: 'ФСП не важен для потребности',
	candidate_formats_unknown: 'кандидат не указал формат — не штрафуется',
	candidate_region_unknown: 'регион не указан — не штрафуется',
	format_other: 'другой формат',
	region_other: 'другой регион',
	relocation: 'готов к переезду',
	no_category: 'категория не подтверждена'
};

export const OFFER_FIT: Record<string, string> = {
	yes: 'да',
	no: 'нет',
	unknown: 'неизвестно',
	relocation: 'готов к переезду'
};

export const CHANGE_NAMES: Record<string, string> = {
	categories: 'категории',
	skill_keys: 'обязательные навыки',
	nice_skill_keys: 'желательные навыки',
	work_format: 'формат',
	region_code: 'регион',
	salary: 'вилка',
	fsp_relevant: 'важность ФСП',
	fsp_only: 'только с ФСП',
	work_formats: 'фильтр по формату',
	confirmed_skill_keys: 'навыки, подтверждённые тестом'
};

export const WHAT_IF_REASONS: Record<string, string> = {
	format_accepted: 'принимает формат',
	format_not_accepted: 'не принимает формат',
	formats_unknown: 'формат не указан',
	category: 'категория',
	skill_confirmed: 'навык подтверждён тестом',
	skill_not_confirmed: 'навык не подтверждён тестом',
	fsp_present: 'есть результат ФСП',
	fsp_absent: 'нет результата ФСП',
	other_condition: 'другое условие подборки'
};

/** A count of a cohort answer: «15» or «< 5». */
export function cohortCount(cell: { value: number } | { below: number }): string {
	return 'value' in cell ? String(cell.value) : `< ${cell.below}`;
}

const money = new Intl.NumberFormat('ru-RU');

export function intervalText(interval: { from: number; to: number | null }): string {
	return interval.to === null
		? `от ${money.format(interval.from)} ₽`
		: `${money.format(interval.from)}–${money.format(interval.to)} ₽`;
}
