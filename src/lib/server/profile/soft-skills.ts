// Soft skills of the profile (docs/domain.md, section 7.1): a fixed list the candidate states by hand or accepts from the
// resume. They are the candidate's own word: no test confirms them, matching and categories never read them, and the
// PDF profile shows them as stated. A resume names one by an alias of the list, and its quote must name it so
// (`resume-extract/v3`, docs/contracts.md, section 3.2).
import { containsTerm, fold, locateQuote } from '$lib/server/ml/quotes';

export interface SoftSkill {
	key: string;
	name: string;
	/** Spellings a resume names the skill by, besides the name; matched as whole words, letter case aside. */
	aliases: readonly string[];
}

export const SOFT_SKILLS: readonly SoftSkill[] = [
	{
		key: 'communication',
		name: 'Коммуникабельность',
		aliases: ['коммуникабельный', 'коммуникабельна', 'коммуникативные навыки', 'communication skills']
	},
	{
		key: 'teamwork',
		name: 'Работа в команде',
		aliases: ['командная работа', 'работать в команде', 'командный игрок', 'teamwork', 'team player']
	},
	{
		key: 'mentoring',
		name: 'Наставничество',
		aliases: ['менторство', 'наставник', 'ментор', 'mentoring', 'mentorship']
	},
	{
		key: 'leadership',
		name: 'Лидерство',
		aliases: ['лидерские качества', 'leadership']
	},
	{
		key: 'responsibility',
		name: 'Ответственность',
		// «Ответственный за релизы» states a duty, not the quality: only the noun counts.
		aliases: ['responsibility']
	},
	{
		key: 'self_learning',
		name: 'Обучаемость',
		aliases: ['быстро обучаюсь', 'быстрая обучаемость', 'самообучение', 'fast learner', 'self-learning']
	},
	{
		key: 'problem_solving',
		name: 'Решение проблем',
		aliases: ['решение задач', 'аналитическое мышление', 'problem solving', 'problem-solving', 'analytical thinking']
	},
	{
		key: 'critical_thinking',
		name: 'Критическое мышление',
		aliases: ['critical thinking']
	},
	{
		key: 'time_management',
		name: 'Тайм-менеджмент',
		aliases: ['тайм менеджмент', 'управление временем', 'time management']
	},
	{
		key: 'stress_resistance',
		name: 'Стрессоустойчивость',
		aliases: ['стрессоустойчивый', 'стрессоустойчива', 'stress resistance']
	},
	{
		key: 'initiative',
		name: 'Инициативность',
		aliases: ['инициативный', 'инициативная', 'proactive']
	},
	{
		key: 'presentation',
		name: 'Публичные выступления',
		aliases: ['навыки презентации', 'выступления на конференциях', 'public speaking', 'presentation skills']
	},
	{
		key: 'negotiation',
		name: 'Переговоры',
		aliases: ['ведение переговоров', 'negotiation']
	},
	{
		key: 'attention_to_detail',
		name: 'Внимание к деталям',
		aliases: ['внимательность к деталям', 'attention to detail']
	}
];

/** Most soft skills a profile states: a longer list says nothing (candidates.soft_skill_keys). */
export const MAX_SOFT_SKILLS = 12;

const BY_KEY: ReadonlyMap<string, SoftSkill> = new Map(SOFT_SKILLS.map((skill) => [skill.key, skill]));

export const isSoftSkillKey = (key: string): boolean => BY_KEY.has(key);

export function softSkillName(key: string): string {
	const skill = BY_KEY.get(key);
	if (!skill) throw new Error(`unknown soft skill ${key}`);
	return skill.name;
}

const spellings = (skill: SoftSkill): string[] => [skill.name, ...skill.aliases];

/**
 * The soft skill the raw text of an item stands for: the one it is a spelling of, or else the only one it names as
 * whole words («Умение работать в команде и …» — `teamwork`); `null` — none, or several.
 */
export function softSkillOf(written: string): SoftSkill | null {
	const text = fold(written);
	const exact = SOFT_SKILLS.find((skill) => spellings(skill).some((spelling) => fold(spelling) === text));
	if (exact) return exact;
	const named = softSkillsIn(written);
	return named.length === 1 && named[0] ? named[0].skill : null;
}

/** The text names the soft skill by one of its spellings, as whole words. */
export const namesSoftSkill = (text: string, skill: SoftSkill): boolean =>
	spellings(skill).some((spelling) => containsTerm(text, spelling));

/**
 * The soft skills a text names, each once, with the words that name it as the text writes them (letter case and all):
 * the quote of a found skill.
 */
export function softSkillsIn(text: string): { skill: SoftSkill; written: string }[] {
	return SOFT_SKILLS.flatMap((skill) => {
		const spelling = spellings(skill).find((candidate) => containsTerm(text, candidate));
		const location = spelling === undefined ? null : locateQuote({ id: 'text', text }, spelling);
		return location === null ? [] : [{ skill, written: location.text }];
	});
}
