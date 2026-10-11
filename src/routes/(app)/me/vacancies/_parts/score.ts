import type { ResolvedPathname } from '$app/types';
import type { MatchComponentKey } from '$lib/components/product/model.js';

// Tone of a match score: one colour per level, the same in the ring, the bars and the captions.
export interface ScoreTone {
	label: string;
	text: string;
	bar: string;
	soft: string;
}

const STRONG: ScoreTone = {
	label: 'сильное совпадение',
	text: 'text-success',
	bar: 'bg-success',
	soft: 'bg-success-subtle text-success'
};

const GOOD: ScoreTone = {
	label: 'хорошее совпадение',
	text: 'text-link',
	bar: 'bg-primary dark:bg-brand-300',
	soft: 'bg-accent text-accent-foreground'
};

const PARTIAL: ScoreTone = {
	label: 'частичное совпадение',
	text: 'text-warning',
	bar: 'bg-warning',
	soft: 'bg-warning-subtle text-warning'
};

export function toneOf(score: number): ScoreTone {
	if (score >= 0.75) return STRONG;
	if (score >= 0.5) return GOOD;
	return PARTIAL;
}

export function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** «1 вакансия», «3 вакансии», «7 вакансий». */
export function plural(count: number, forms: [string, string, string]): string {
	const tens = count % 100;
	const ones = count % 10;
	if (tens >= 11 && tens <= 14) return forms[2];
	if (ones === 1) return forms[0];
	if (ones >= 2 && ones <= 4) return forms[1];
	return forms[2];
}

/** The addresses of the view are built with `resolve()` by the page; this only restores their type. */
export function pathOf(href: string): ResolvedPathname {
	return href as ResolvedPathname;
}

/** Short names of the match components, for narrow bars and the radar. */
export const componentShort: Record<MatchComponentKey, string> = {
	required: 'Обязательные',
	nice: 'Желательные',
	role: 'Роль',
	trust: 'Доверие',
	grade: 'Грейд',
	salary: 'Зарплата',
	semantic: 'Смысл',
	reranker: 'Модель'
};
