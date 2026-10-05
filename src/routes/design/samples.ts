/**
 * Example view models for the component showcase. They exercise every state of the components and describe
 * no real person, company or result.
 */
import type {
	AchievementView,
	CategoryBadgeView,
	DisciplineCode,
	FspLevel,
	HiringView,
	MatchView,
	ReceiptView,
	SalaryComparison,
	SalaryView
} from '$lib/components/product/model.js';

export const receipts: { caption: string; receipt: ReceiptView }[] = [
	{
		caption: 'Обобщённые сведения, как в каталоге',
		receipt: {
			handle: 'R7KQ2M4XWB5TDN3HJ6PZ8CVA4E',
			source: 'fsp',
			title: 'призёр всероссийского соревнования, продуктовое программирование',
			verifiedAt: '2026-09-20T09:00:00Z',
			status: 'valid',
			disclosure: 'generalized',
			asserts: [
				{ label: 'Дисциплина', value: 'программирование продуктовое' },
				{ label: 'Уровень', value: 'всероссийское соревнование' },
				{ label: 'Сезон', value: '2025' },
				{ label: 'Результат', value: 'призёр' },
				{ label: 'Формат', value: 'очно' }
			],
			doesNotAssert: ['Личный вклад в командное решение', 'Владение конкретным языком', 'Коммерческий опыт'],
			signingKeyId: 'k-2026-09'
		}
	},
	{
		caption: 'Тест платформы, точные сведения',
		receipt: {
			handle: 'T3VJ9LQ5ZC2WM8RKX4HB6NDF7A',
			source: 'platform_test',
			title: 'задание «Сервис на Go с PostgreSQL», версия 3',
			verifiedAt: '2026-09-18T14:30:00Z',
			status: 'valid',
			disclosure: 'exact',
			asserts: [
				{ label: 'Навык', value: 'Go, PostgreSQL' },
				{ label: 'Оценка', value: 'засчитана, 86 из 100' },
				{ label: 'Покрытие', value: 'HTTP API, транзакции, тесты' }
			],
			doesNotAssert: ['Самостоятельность выполнения', 'Навыки за пределами покрытия задания'],
			signingKeyId: 'k-2026-09'
		}
	},
	{
		caption: 'Результат аннулирован источником',
		receipt: {
			handle: 'A9PX4KD2QW7ZM5TRC3BN8VHJ6L',
			source: 'fsp',
			title: 'финалист регионального соревнования, алгоритмическое программирование',
			verifiedAt: '2026-08-02T10:00:00Z',
			status: 'annulled',
			disclosure: 'generalized',
			asserts: [
				{ label: 'Дисциплина', value: 'программирование алгоритмическое' },
				{ label: 'Уровень', value: 'региональное соревнование' },
				{ label: 'Результат', value: 'финалист' }
			],
			doesNotAssert: ['Владение конкретным языком', 'Коммерческий опыт'],
			signingKeyId: 'k-2026-08'
		}
	}
];

export const achievements: { caption: string; achievement: AchievementView }[] = [
	{
		caption: 'Обобщённо, командный зачёт, очно',
		achievement: {
			discipline: 'product',
			level: 'russian_cup',
			award: 'prize',
			format: 'onsite',
			season: 2025,
			team: true
		}
	},
	{
		caption: 'Точно: кандидат 18+ открыл точные достижения',
		achievement: {
			discipline: 'algorithmic',
			level: 'russian_championship',
			award: 'winner',
			format: 'onsite',
			season: 2026,
			team: false,
			evskIndicator: 'KMS',
			exact: { competition: 'Финал чемпионата России, личный зачёт', place: 1, placeOf: 120 }
		}
	},
	{
		caption: 'Онлайн-отбор, участник',
		achievement: {
			discipline: 'infosec',
			level: 'all_russian_ekp',
			award: 'participant',
			format: 'online',
			season: 2026,
			team: true
		}
	},
	{
		caption: 'Источник не передал формат и результат',
		achievement: {
			discipline: 'uas',
			level: 'unknown',
			award: 'unknown',
			format: 'unknown',
			season: 2024,
			team: false
		}
	}
];

export const categories: {
	caption: string;
	categories: CategoryBadgeView[];
	fspLevels: { discipline: DisciplineCode; level: FspLevel }[];
}[] = [
	{
		caption: 'Подтверждена тестом',
		categories: [
			{
				key: 'backend',
				specialization: 'Backend',
				grade: 'Middle',
				skills: ['Go', 'SQL', 'REST', 'Многопоточность'],
				blocks: 5,
				assignedOn: '2026-10-02'
			}
		],
		fspLevels: [{ discipline: 'product', level: 'L3' }]
	},
	{
		caption: 'Две специализации',
		categories: [
			{
				key: 'backend',
				specialization: 'Backend',
				grade: 'Junior',
				skills: ['Python', 'SQL'],
				blocks: 4,
				assignedOn: '2026-09-28'
			},
			{
				key: 'data_ml',
				specialization: 'Data Science / ML',
				grade: 'Intern',
				skills: ['Статистика', 'Python'],
				blocks: 3,
				assignedOn: '2026-10-03'
			}
		],
		fspLevels: [
			{ discipline: 'algorithmic', level: 'L4' },
			{ discipline: 'product', level: 'L2' }
		]
	},
	{
		caption: 'Категория не подтверждена',
		categories: [],
		fspLevels: [{ discipline: 'algorithmic', level: 'L2' }]
	}
];

export const match: MatchView = {
	score: 0.78,
	components: [
		{ key: 'required', status: 'computed', value: 0.83, weight: 0.45 },
		{ key: 'nice', status: 'computed', value: 0.5, weight: 0.15 },
		{ key: 'trust', status: 'computed', value: 0.67, weight: 0.2 },
		{ key: 'grade', status: 'unknown', reason: 'Грейд кандидата не установлен — проверить на собеседовании.' },
		{ key: 'salary', status: 'not_comparable', reason: 'Ожидания указаны на руки, вилка — до вычета НДФЛ.' },
		{ key: 'semantic', status: 'computed', value: 0.81, weight: 0.2 },
		{ key: 'reranker', status: 'unavailable', reason: 'Уточняющая модель недоступна.' }
	],
	matches: [
		{ requirement: 'Go', evidence: 'тест платформы, задание версии 3', trust: 'platform_verified' },
		{ requirement: 'Алгоритмы', evidence: 'призёр всероссийского соревнования', trust: 'fsp_verified' },
		{ requirement: 'PostgreSQL', evidence: 'резюме, цитата из опыта работы', trust: 'claimed' },
		{ requirement: 'Командная работа', evidence: 'командное соревнование без персональной роли', trust: 'derived' }
	],
	unknown: ['Грейд кандидата'],
	toVerify: ['Опыт с Kafka в продакшене', 'Ожидания по зарплате до вычета НДФЛ'],
	gaps: ['Kubernetes — обязательный навык не подтверждён']
};

export const salaries: {
	caption: string;
	salary: SalaryView;
	comparison?: { result: SalaryComparison; against: string };
}[] = [
	{
		caption: 'Полная вилка',
		salary: { min: 200_000, max: 230_000, currency: 'RUB', period: 'month', taxBase: 'net' },
		comparison: { result: 'lower', against: 'медианы вилок вакансий категории' }
	},
	{
		caption: 'Только нижняя граница',
		salary: { min: 250_000, max: null, currency: 'RUB', period: 'month', taxBase: 'gross' }
	},
	{
		caption: 'Только верхняя граница',
		salary: { min: null, max: 3_000, currency: 'USD', period: 'month', taxBase: 'gross' }
	},
	{
		caption: 'Налоговая база не указана',
		salary: { min: 180_000, max: 220_000, currency: 'RUB', period: 'month', taxBase: 'unknown' },
		comparison: { result: 'not_comparable', against: 'ожиданиями кандидата' }
	},
	{ caption: 'Зарплата не указана', salary: { min: null, max: null } }
];

export const hiring: { caption: string; hiring: HiringView }[] = [
	{
		caption: 'Собеседование назначено, исход ожидается',
		hiring: {
			stages: { interview_scheduled: ['company'] },
			outcome: { state: 'pending', reports: [] }
		}
	},
	{
		caption: 'Выход подтверждён обеими сторонами',
		hiring: {
			stages: {
				interview_scheduled: ['company'],
				interview_done: ['company', 'candidate'],
				offer_made: ['company'],
				offer_accepted: ['candidate']
			},
			outcome: {
				state: 'confirmed',
				reports: [
					{ party: 'company', outcome: 'hired' },
					{ party: 'candidate', outcome: 'hired' }
				]
			}
		}
	},
	{
		caption: 'Стороны отметили исход по-разному',
		hiring: {
			stages: { interview_scheduled: ['candidate'], interview_done: ['candidate'] },
			outcome: {
				state: 'diverged',
				reports: [
					{ party: 'company', outcome: 'not_hired' },
					{ party: 'candidate', outcome: 'hired' }
				]
			}
		}
	},
	{
		caption: 'Исход неизвестен',
		hiring: { stages: {}, outcome: { state: 'unknown', reports: [] } }
	}
];

export const candidates = [
	{ pseudonym: 'Кандидат 7F3A', role: 'Бэкенд-разработчик', grade: 'Младший – Средний', match: 0.78 },
	{ pseudonym: 'Кандидат 2C9D', role: 'Бэкенд-разработчик', grade: 'не установлен', match: 0.71 },
	{ pseudonym: 'Кандидат B41E', role: 'Фулстек-разработчик', grade: 'Средний', match: 0.64 }
];
