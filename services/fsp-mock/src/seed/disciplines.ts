import type { Discipline, DisciplineCode } from '../types.ts';

/** Five disciplines of the sport (ВРВС codes from the regulations on all-Russian competitions). */
export const DISCIPLINES: readonly Discipline[] = [
	{ code: 'algorithmic', name: 'Программирование алгоритмическое', vrvsCode: '1010011811Я', format: 'both' },
	{ code: 'product', name: 'Программирование продуктовое', vrvsCode: '1010021811Я', format: 'team' },
	{
		code: 'uas',
		name: 'Программирование беспилотных авиационных систем',
		vrvsCode: '1010031811Я',
		format: 'individual'
	},
	{ code: 'robotics', name: 'Программирование робототехники', vrvsCode: '1010041811Я', format: 'both' },
	{
		code: 'infosec',
		name: 'Программирование систем информационной безопасности',
		vrvsCode: '1010051811Я',
		format: 'both'
	}
];

/** Team sizes (athletes, without the coach) by discipline, from the competition regulations. */
export const TEAM_SIZE: Record<DisciplineCode, readonly [number, number]> = {
	algorithmic: [3, 3],
	product: [3, 6],
	uas: [1, 1],
	robotics: [2, 4],
	infosec: [2, 5]
};

/** Personal function in a team, when the source knows it. */
export const SPECIALIZATIONS: Record<DisciplineCode, readonly string[]> = {
	algorithmic: [],
	product: ['backend', 'frontend', 'fullstack', 'ml', 'design', 'pm', 'mobile', 'devops'],
	uas: [],
	robotics: ['embedded', 'cv', 'control', 'mechanics'],
	infosec: ['pentest', 'web', 'reverse', 'crypto', 'forensics', 'pwn']
};
