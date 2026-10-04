// Demo athletes with fixed identifiers and designed histories: each covers a scenario of the platform.
// People are synthetic; the competitions they took part in are real (catalog.ts).

import type { Account } from '../accounts.ts';
import type {
	AgeGroup,
	CompetitionLevel,
	DisciplineCode,
	Qualification,
	ResultStatus,
	Stage,
	TeamRole
} from '../types.ts';
import type { SyntheticName } from './names.ts';
import { Random } from './random.ts';

export interface HeroEntry {
	select: {
		discipline: DisciplineCode;
		level?: CompetitionLevel | 'unknown';
		stage?: Stage;
		year?: number;
		ageGroup?: AgeGroup;
		online?: boolean;
		format?: 'individual' | 'team';
	};
	place: number;
	role?: TeamRole;
	/** `null` — the source states no personal specialization; absent — the field is not sent. */
	specialization?: string | null;
	status?: ResultStatus;
	/** Team role string the source could not map: the result carries `role: 'unknown'` and the raw value. */
	rawRole?: string;
	teamName?: string;
	teamSize?: number;
}

export interface HeroSpec {
	key: string;
	fspId: string;
	title: string;
	scenario: string;
	name: SyntheticName;
	birthYear: number;
	region: string;
	disciplines: DisciplineCode[];
	skill: number;
	/** Also takes part in generated competitions besides the designed entries. */
	randomActivity: boolean;
	/** Ranks are assigned for every fulfilled norm (true) or never (false: the norm is fulfilled, the rank is not). */
	assignRanks: boolean;
	entries: HeroEntry[];
	/** Enter every past competition of these disciplines the athlete's age allows (long history, several pages). */
	enterAllOf?: DisciplineCode[];
	foncodeRating?: number;
	nationalTeam?: { discipline: DisciplineCode; squad: 'main' | 'reserve'; season: number };
	extraQualifications?: Qualification[];
}

/** Stable UUID per key, independent of the dataset seed and size. */
function fixedId(key: string): string {
	return new Random(`fixed:${key}`).uuid();
}

export const HEROES: readonly HeroSpec[] = [
	{
		key: 'algo_kms',
		fspId: fixedId('algo_kms'),
		title: 'Алгоритмист, КМС',
		scenario: 'призёр финала Кубка России 2025, КМС присвоен, рейтинг Фонкода, резерв сборной',
		name: { lastName: 'Соколов', firstName: 'Глеб', middleName: 'Андреевич', gender: 'male' },
		birthYear: 2003,
		region: 'Новосибирская область',
		disciplines: ['algorithmic'],
		skill: 2.6,
		randomActivity: true,
		assignRanks: true,
		entries: [
			{ select: { discipline: 'algorithmic', level: 'russian_cup', stage: 'qualifier', year: 2025 }, place: 4 },
			{ select: { discipline: 'algorithmic', level: 'russian_cup', stage: 'final', year: 2025 }, place: 2 },
			{
				select: {
					discipline: 'algorithmic',
					level: 'all_russian_ekp',
					stage: 'final',
					year: 2025,
					ageGroup: 'juniors_u26'
				},
				place: 1
			}
		],
		foncodeRating: 2240,
		nationalTeam: { discipline: 'algorithmic', squad: 'reserve', season: 2026 }
	},
	{
		key: 'teen_14',
		fspId: fixedId('teen_14'),
		title: 'Школьница, 14 лет',
		scenario: 'несовершеннолетний: юношеские соревнования 2026, свежий результат ещё предварительный',
		name: { lastName: 'Воробьёва', firstName: 'Злата', middleName: 'Игоревна', gender: 'female' },
		birthYear: 2012,
		region: 'Смоленская область',
		disciplines: ['algorithmic'],
		skill: 1.2,
		randomActivity: false,
		assignRanks: true,
		entries: [
			{ select: { discipline: 'algorithmic', level: 'regional_cup', year: 2026, ageGroup: 'juniors_u19' }, place: 3 },
			{
				select: { discipline: 'algorithmic', level: 'international_ekp', year: 2026, ageGroup: 'juniors_u19' },
				place: 12
			}
		]
	},
	{
		key: 'teen_16',
		fspId: fixedId('teen_16'),
		title: 'Школьница, 16 лет, командный призёр',
		scenario: 'несовершеннолетняя: 2 место Первенства России по продуктовому в команде, frontend, I разряд',
		name: { lastName: 'Захарова', firstName: 'Алиса', middleName: 'Сергеевна', gender: 'female' },
		birthYear: 2010,
		region: 'Воронежская область',
		disciplines: ['product'],
		skill: 1.4,
		randomActivity: false,
		assignRanks: true,
		entries: [
			{
				select: { discipline: 'product', level: 'russian_youth_championship', stage: 'single', year: 2025 },
				place: 2,
				role: 'athlete',
				specialization: 'frontend',
				teamSize: 5
			},
			{
				select: { discipline: 'product', level: 'russian_youth_championship', stage: 'qualifier', year: 2026 },
				place: 3,
				role: 'captain',
				specialization: 'frontend',
				teamSize: 5
			}
		]
	},
	{
		key: 'team_no_spec',
		fspId: fixedId('team_no_spec'),
		title: 'Командный призёр без специализации',
		scenario:
			'3 место финала Кубка России 2025 по продуктовому, роль в команде не передана; норма КМС выполнена, разряд не присвоен',
		name: { lastName: 'Климов', firstName: 'Матвей', middleName: 'Олегович', gender: 'male' },
		birthYear: 2001,
		region: 'Самарская область',
		disciplines: ['product'],
		skill: 1.5,
		randomActivity: false,
		assignRanks: false,
		entries: [
			{
				select: { discipline: 'product', level: 'russian_cup', stage: 'qualifier', year: 2025 },
				place: 6,
				role: 'athlete',
				specialization: null,
				teamSize: 5
			},
			{
				select: { discipline: 'product', level: 'russian_cup', stage: 'final', year: 2025 },
				place: 3,
				role: 'athlete',
				specialization: null,
				teamSize: 5
			}
		]
	},
	{
		key: 'captain_backend',
		fspId: fixedId('captain_backend'),
		title: 'Капитан, backend, МС',
		scenario: 'чемпион России 2025 по продуктовому капитаном команды, специализация backend, МС присвоен',
		name: { lastName: 'Родионов', firstName: 'Степан', middleName: 'Викторович', gender: 'male' },
		birthYear: 1999,
		region: 'Республика Татарстан',
		disciplines: ['product'],
		skill: 2.2,
		randomActivity: true,
		assignRanks: true,
		entries: [
			{
				select: { discipline: 'product', level: 'russian_championship', stage: 'single', year: 2025 },
				place: 1,
				role: 'captain',
				specialization: 'backend',
				teamSize: 4
			},
			{
				select: { discipline: 'product', level: 'russian_cup', stage: 'final', year: 2026 },
				place: 5,
				role: 'captain',
				specialization: 'backend',
				teamSize: 4
			}
		]
	},
	{
		key: 'online_vs_final',
		fspId: fixedId('online_vs_final'),
		title: 'Онлайн-отбор против очного финала',
		scenario: 'ИБ: 1 место онлайн-отбора Кубка России 2026 и 9 место очного финала того же сезона',
		name: { lastName: 'Ильин', firstName: 'Тимур', middleName: 'Русланович', gender: 'male' },
		birthYear: 2004,
		region: 'Москва',
		disciplines: ['infosec'],
		skill: 1.8,
		randomActivity: false,
		assignRanks: true,
		entries: [
			{
				select: { discipline: 'infosec', level: 'russian_cup', stage: 'qualifier', year: 2026 },
				place: 1,
				role: 'captain',
				specialization: 'pentest',
				teamSize: 4
			},
			{
				select: { discipline: 'infosec', level: 'russian_cup', stage: 'final', year: 2026 },
				place: 9,
				role: 'captain',
				specialization: 'pentest',
				teamSize: 4
			}
		]
	},
	{
		key: 'long_history',
		fspId: fixedId('long_history'),
		title: 'Длинная история',
		scenario: 'алгоритмика и робототехника с 2024 года: больше двадцати результатов, несколько страниц',
		name: { lastName: 'Макаров', firstName: 'Денис', middleName: 'Павлович', gender: 'male' },
		birthYear: 2002,
		region: 'Пермский край',
		disciplines: ['algorithmic', 'robotics'],
		skill: 1.3,
		randomActivity: false,
		assignRanks: true,
		entries: [],
		enterAllOf: ['algorithmic', 'robotics'],
		foncodeRating: 1810
	},
	{
		key: 'annulled',
		fspId: fixedId('annulled'),
		title: 'Аннулированный и предварительный результаты',
		scenario: 'БАС: финал Кубка России 2025 аннулирован, отбор 2026 ещё предварительный',
		name: { lastName: 'Сафонова', firstName: 'Вероника', middleName: 'Денисовна', gender: 'female' },
		birthYear: 2000,
		region: 'Санкт-Петербург',
		disciplines: ['uas'],
		skill: 1.6,
		randomActivity: false,
		assignRanks: true,
		entries: [
			{ select: { discipline: 'uas', level: 'russian_cup', stage: 'qualifier', year: 2025 }, place: 2 },
			{ select: { discipline: 'uas', level: 'russian_cup', stage: 'final', year: 2025 }, place: 3, status: 'annulled' },
			{
				select: { discipline: 'uas', level: 'russian_cup', stage: 'qualifier', year: 2026 },
				place: 7,
				status: 'preliminary'
			}
		]
	},
	{
		key: 'unknown_role',
		fspId: fixedId('unknown_role'),
		title: 'Неизвестная роль в команде',
		scenario: 'робототехника: 2 место финала Чемпионата России 2025, роль передана значением вне справочника',
		name: { lastName: 'Харитонов', firstName: 'Лев', middleName: 'Максимович', gender: 'male' },
		birthYear: 2005,
		region: 'Пермский край',
		disciplines: ['robotics'],
		skill: 1.4,
		randomActivity: false,
		assignRanks: true,
		entries: [
			{
				select: { discipline: 'robotics', level: 'russian_championship', stage: 'final', year: 2025 },
				place: 2,
				rawRole: 'оператор',
				teamSize: 3
			}
		]
	},
	{
		key: 'no_results',
		fspId: fixedId('no_results'),
		title: 'Спортсмен без результатов',
		scenario: 'профиль спортсмена есть, соревнований ещё нет: пустой снимок',
		name: { lastName: 'Панова', firstName: 'Дарья', middleName: null, gender: 'female' },
		birthYear: 1998,
		region: 'Ярославская область',
		disciplines: ['product'],
		skill: 0,
		randomActivity: false,
		assignRanks: false,
		entries: []
	}
];

export interface ServiceAccount {
	account: Account;
	title: string;
	scenario: string;
}

export const SERVICE_ACCOUNTS: readonly ServiceAccount[] = [
	{
		account: {
			sub: fixedId('no_athlete_profile'),
			email: 'nikita.belov@example.com',
			givenName: 'Никита',
			familyName: 'Белов',
			preferredUsername: 'nikita.belov',
			kind: 'no_athlete_profile'
		},
		title: 'ФСП ID без профиля спортсмена',
		scenario: 'вход работает, API достижений отвечает not_found'
	},
	{
		account: {
			sub: fixedId('employer'),
			email: 'hr.lead@example.com',
			givenName: 'Ольга',
			familyName: 'Кравец',
			preferredUsername: 'hr.lead',
			kind: 'employer'
		},
		title: 'Представитель работодателя',
		scenario: 'вход через ФСП ID без спортивного профиля'
	},
	{
		account: {
			sub: fixedId('fsp_operator'),
			email: 'operator@example.com',
			givenName: 'Андрей',
			familyName: 'Сорокин',
			preferredUsername: 'fsp.operator',
			kind: 'fsp_operator'
		},
		title: 'Сотрудник ФСП',
		scenario: 'оператор федерации, без спортивного профиля'
	}
];

export function hero(key: string): HeroSpec {
	const found = HEROES.find((h) => h.key === key);
	if (!found) throw new Error(`unknown hero ${key}`);
	return found;
}
