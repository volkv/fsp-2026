// Copy of the landing page, kept apart from its layout: the sections differ in form, not in what they promise.
import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
import TrophyIcon from '@lucide/svelte/icons/trophy';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import { pluralize, type TrustLevel } from '$lib/components/product/model.js';
import type { PlatformMetrics } from '$lib/server/landing/metrics';

export const TITLE = 'ФСП | Карьера';
export const TAGLINE = 'Платформа ИТ-найма, где навыки подтверждены';
export const DESCRIPTION =
	'Работодатель сам находит ИТ-специалиста по проверенному профилю и первым предлагает работу с зарплатой. ' +
	'Грейд подтверждает тест, достижения — Федерация спортивного программирования.';

/** The short promise of the first screen: one sentence each, for layouts that keep the hero sparse. */
export const PROMISE = {
	employer: 'Работодатель сам находит специалиста и первым предлагает работу с зарплатой.',
	candidate: 'Категорию назначает только тест. Каждый навык подписан тем, чем он подтверждён.'
} as const;

const figureFormat = new Intl.NumberFormat('ru-RU');

export function formatFigure(value: number): string {
	return figureFormat.format(value);
}

export interface Metric {
	value: number;
	/** The caption without the figure, e.g. «ИТ-ролей в справочнике категорий». */
	text: string;
	/** A two-word caption for tight layouts. */
	short: string;
}

/** Figures of the platform from the database; a figure the database does not have yet is not shown. */
export function landingMetrics({ taxonomy, taskFamilies }: PlatformMetrics): Metric[] {
	const shown: Metric[] = [];
	if (taxonomy !== null && taxonomy.roles > 0) {
		const word = pluralize(taxonomy.roles, ['ИТ-роль', 'ИТ-роли', 'ИТ-ролей']);
		shown.push({ value: taxonomy.roles, text: `${word} в справочнике категорий`, short: word });
	}
	if (taxonomy !== null && taxonomy.skills > 0) {
		const word = pluralize(taxonomy.skills, ['навык', 'навыка', 'навыков']);
		shown.push({
			value: taxonomy.skills,
			text: `${word} с синонимами из вакансий и резюме`,
			short: `${word} в словаре`
		});
	}
	if (taskFamilies > 0) {
		const word = pluralize(taskFamilies, ['шаблон', 'шаблона', 'шаблонов']);
		shown.push({
			value: taskFamilies,
			text: `${word} заданий: у каждого кандидата свои варианты`,
			short: `${word} заданий`
		});
	}
	return shown;
}

export interface Fact {
	value: string;
	unit: string;
	text: string;
	source: string;
	href: string;
}

/** Market figures; each is shown only with its source. */
export const FACTS: Fact[] = [
	{
		value: '21,4',
		unit: '%',
		text: 'откликов соответствуют требованиям вакансии',
		source: 'Хантфлоу и Джун, первое полугодие 2026, 753 162 отклика в 133 компаниях',
		href: 'https://huntflow.media/iz-pyati-otklikov-na-vakansiyu-podhodit-tolko-odin/'
	},
	{
		value: '52',
		unit: 'часа',
		text: 'проходит до первого действия рекрутера с откликом',
		source: 'Хантфлоу и Джун, первое полугодие 2026',
		href: 'https://huntflow.media/iz-pyati-otklikov-na-vakansiyu-podhodit-tolko-odin/'
	},
	{
		value: '44,5',
		unit: 'дня',
		text: 'медиана закрытия ИТ-вакансии',
		source: 'Поток, 2025, 1 762 ИТ-вакансии',
		href: 'https://potok.io/blog/hr-news/time-to-hire-report-2025/'
	}
];

export interface Audience {
	/** Anchor of the section: the public navigation links to `/#employers`, `/#candidates`, `/#fsp`. */
	id: 'employers' | 'candidates' | 'fsp';
	icon: typeof BriefcaseIcon;
	title: string;
	lead: string;
	/** One short line per point, for layouts that do not show the full points. */
	short: string[];
	points: string[];
}

export const AUDIENCES: Audience[] = [
	{
		id: 'employers',
		icon: BriefcaseIcon,
		title: 'Работодателям',
		lead: 'Находите ИТ-специалистов по проверенным навыкам и пишите первыми — сразу с зарплатой. Вакансия не нужна.',
		short: [
			'Опишите, кого ищете, — своими словами',
			'Подборка с объяснением по каждому',
			'Предложение с вилкой в рублях'
		],
		points: [
			'Опишите, кого ищете, своими словами или в форме — платформа предложит категории и покажет, сколько в них кандидатов.',
			'Подборка с объяснением по каждому кандидату: что подходит, чем подтверждено, что уточнить на собеседовании.',
			'Предложение с вилкой в рублях и пунктами «почему вы» — из подборки, по решению вызова или по отклику на вашу вакансию.'
		]
	},
	{
		id: 'candidates',
		icon: UserRoundIcon,
		title: 'Кандидатам',
		lead: 'Работодатели находят вас сами — без откликов вслепую.',
		short: ['Грейд подтверждает тест', 'Достижения ФСП — через ФСП ID', 'Контакты — только после вашего «да»'],
		points: [
			'Пройдите опрос, заявите грейд и подтвердите его тестом: ваша категория — специализация и грейд по тесту.',
			'Достижения ФСП через ФСП ID, резюме и публичные профили подтверждают навыки и влияют на место в подборке, но грейд не меняют.',
			'В предложении видно, что компания нашла в вашем профиле. Контакты получает только компания, чьё предложение вы приняли.'
		]
	},
	{
		id: 'fsp',
		icon: TrophyIcon,
		title: 'Федерации',
		lead: 'Карьерный лифт федерации, который можно измерить.',
		short: ['Проверка работодателей', 'Карьерный путь участников', 'Навыки, которые ищет рынок'],
		points: [
			'Проверка работодателей и разбор возражений по категориям.',
			'Карьерный путь участников по стадиям: предложения компаний, контакты, собеседования, выходы — и честно, где результат неизвестен.',
			'Какие навыки ищет рынок и какие дают соревнования.'
		]
	}
];

export interface Step {
	title: string;
	text: string;
}

export const STEPS: Step[] = [
	{
		title: 'Тест',
		text: 'Кандидат заявляет грейд и подтверждает его тестом; достижения ФСП и резюме добавляют доказательства.'
	},
	{
		title: 'Потребность',
		text: 'Работодатель описывает, кого ищет, и получает подборку проверенных кандидатов с объяснением.'
	},
	{
		title: 'Предложение',
		text: 'Работодатель пишет первым: вилка в рублях, «почему вы» и срок ответа. Вакансия не обязательна.'
	},
	{
		title: 'Решение',
		text: 'Принятое предложение открывает контакты и переписку; стороны отмечают этапы найма, федерация видит, куда уходят участники.'
	}
];

/** Trust levels of a skill, strongest first; their labels and meaning come from `TRUST`. */
export const TRUST_LADDER: TrustLevel[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed'];
