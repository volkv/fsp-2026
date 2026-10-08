// The catalog of categories (docs/domain.md, section 12.1): six specializations, four grades and, for every pair, the
// definition of the grade — the blocks of competence its test covers with the number of items each block gives to the
// longest trajectory, the practice task, the borderline candidate in words and what the test does not check. A category
// of a candidate is a specialization and a grade confirmed by a test of this catalog; nothing else assigns one.
//
// The catalog is data of the frozen contract: it changes only as a new version (`CATALOG.version`), and the records made
// by it name the version. Plain erasable TypeScript without `$lib`, so that start-up scripts run it with bare Node.

export const SPECIALIZATION_KEYS = ['backend', 'frontend', 'mobile', 'data_ml', 'qa', 'devops'] as const;
export type SpecializationKey = (typeof SPECIALIZATION_KEYS)[number];

/** Grades a candidate declares and a test confirms, lowest first; Lead is not declared. */
export const GRADE_KEYS = ['intern', 'junior', 'middle', 'senior'] as const;
export type GradeKey = (typeof GRADE_KEYS)[number];

/** The first question of the survey: a direction groups specializations. */
export const DIRECTION_KEYS = ['development', 'data', 'quality', 'infrastructure'] as const;
export type DirectionKey = (typeof DIRECTION_KEYS)[number];

/**
 * Formats of items. Every answer is computed by the family's code: a trace of code or SQL, the line of a defect, a
 * computed value, the result of a configuration, a program run against hidden tests, test cases run against mutants.
 */
export const ITEM_FORMATS = [
	'code_trace',
	'sql_trace',
	'bug_locate',
	'compute',
	'config_eval',
	'practice_code',
	'qa_mutation'
] as const;
export type ItemFormat = (typeof ITEM_FORMATS)[number];

/** Formats of the practice slot: they run in the sandbox and are scored by a rubric over groups of runs. */
export const PRACTICE_FORMATS = ['practice_code', 'qa_mutation'] as const satisfies readonly ItemFormat[];

/**
 * Language keys of the sandbox image (services/sandbox/languages.json); a unit test keeps the two lists equal.
 */
export const SANDBOX_LANGUAGE_KEYS = [
	'python3',
	'javascript',
	'typescript',
	'go',
	'cpp17',
	'java21',
	'kotlin'
] as const;
export type SandboxLanguageKey = (typeof SANDBOX_LANGUAGE_KEYS)[number];

/**
 * Languages a practice task may be written in: those of the image. A specialization whose practice language the image
 * lacks cannot be switched on, and its bank cannot be released (the validator checks both against the image's set).
 */
export const PRACTICE_LANGUAGE_KEYS = SANDBOX_LANGUAGE_KEYS;
export type PracticeLanguageKey = (typeof PRACTICE_LANGUAGE_KEYS)[number];

/**
 * Languages of traced code whose answer the generator computes itself (a model of the semantics checked against the
 * real tool when the family is admitted), so the sandbox of the stand needs no compiler for them.
 */
export const GENERATOR_LANGUAGE_KEYS = ['kotlin', 'shell', 'sql', 'yaml', 'dockerfile', 'promql', 'hcl'] as const;

/** The skill of the taxonomy a practice language confirms when the practice gate is passed (domain 12.4). */
export const PRACTICE_LANGUAGE_SKILLS: Readonly<Record<PracticeLanguageKey, string>> = {
	python3: 'python',
	javascript: 'javascript',
	typescript: 'typescript',
	go: 'go',
	cpp17: 'cpp',
	java21: 'java',
	kotlin: 'kotlin'
};

export interface DirectionDefinition {
	key: DirectionKey;
	title: string;
}

export interface SpecializationDefinition {
	key: SpecializationKey;
	title: string;
	direction: DirectionKey;
	/**
	 * The one switch of a specialization: `disabled` takes it out of the survey, the API, the search, the parsing of a
	 * need and the test of a vacancy. A specialization is open when it is `enabled` and its bank has a released version.
	 */
	availability: 'enabled' | 'disabled';
	/** What the specialization is about, for the survey. */
	summary: string;
	practiceLanguages: readonly PracticeLanguageKey[];
}

/** A grade of the catalog; its name is the taxonomy's (`categories/labels.ts`), one for every page. */
export interface GradeLevel {
	key: GradeKey;
	ordinal: number;
}

export interface BlockDefinition {
	/** `<prefix>.<name>`; the prefix names the specialization. */
	code: string;
	specialization: SpecializationKey;
	title: string;
	/** What the items of the block check, for the candidate before the test and for the employer next to the result. */
	checks: string;
	/** Skills of the taxonomy the block confirms when it is a defining block of a confirmed grade (domain 12.4); empty — none. */
	skillKeys: readonly string[];
	formats: readonly ItemFormat[];
	/** The block of the practice slot: only practice formats, one item per test. */
	practice: boolean;
}

export interface BlockQuota {
	block: string;
	/** Items of the block on the longest trajectory (the main part and the extension together). */
	items: number;
}

export interface PracticeSpec {
	block: string;
	/**
	 * 1-based slot position of the practice; not after the slot of the minimum number of items, so every decision sees
	 * it. The practice is a gate, not a summand of the procedure (domain 10.6).
	 */
	position: number;
	/** The practice cluster carries the step «измени своё решение». */
	changeStep: boolean;
	/** The practice gate: a practice cluster scored under this share ends the attempt «не подтверждено» at once. */
	gateMinScore: number;
}

export interface GradeDefinition {
	specialization: SpecializationKey;
	grade: GradeKey;
	/** The borderline candidate of the grade: what they do surely and where they still err. */
	borderline: string;
	/** What a confirmed candidate of the grade is expected to do, as the items check it. */
	expects: readonly string[];
	/** Required blocks with their items on the longest trajectory; the practice block is among them with one item. */
	blocks: readonly BlockQuota[];
	/**
	 * The two defining blocks of the grade: each is served first (three items before the minimum length), a confirmation
	 * needs each of them not failed, and the confirmed stack is theirs (domain 10.6, 12.4). Each has a quota of ≥ 3.
	 */
	defining: readonly string[];
	practice: PracticeSpec;
	/** What the test of this pair does not check, beyond `CATALOG.commonDoesNotCheck`. */
	doesNotCheck: readonly string[];
}

export interface Catalog {
	version: string;
	directions: readonly DirectionDefinition[];
	specializations: readonly SpecializationDefinition[];
	grades: readonly GradeLevel[];
	blocks: readonly BlockDefinition[];
	definitions: readonly GradeDefinition[];
	/** What no test of the catalog checks; shown with every result and every confirmation. */
	commonDoesNotCheck: readonly string[];
}

const SENIOR_DOES_NOT_CHECK = [
	'Руководство людьми и наставничество',
	'Решения в условиях неопределённости бизнеса и переговоры с заказчиком'
] as const;

export const CATALOG: Catalog = {
	version: '2026.10.3',
	directions: [
		{ key: 'development', title: 'Разработка' },
		{ key: 'data', title: 'Данные и машинное обучение' },
		{ key: 'quality', title: 'Качество и тестирование' },
		{ key: 'infrastructure', title: 'Инфраструктура и эксплуатация' }
	],
	specializations: [
		{
			key: 'backend',
			title: 'Backend',
			direction: 'development',
			availability: 'enabled',
			summary: 'Серверная логика, хранение данных, API и конкурентность.',
			practiceLanguages: ['python3', 'go', 'java21', 'javascript', 'typescript', 'cpp17']
		},
		{
			key: 'frontend',
			title: 'Frontend',
			direction: 'development',
			availability: 'enabled',
			summary: 'Браузерная часть: JavaScript и TypeScript, асинхронность, DOM и состояние интерфейса.',
			practiceLanguages: ['javascript', 'typescript']
		},
		{
			key: 'mobile',
			title: 'Mobile',
			direction: 'development',
			availability: 'enabled',
			summary: 'Приложения под Android на Kotlin: язык, корутины, жизненный цикл, интерфейс и данные.',
			practiceLanguages: ['kotlin']
		},
		{
			key: 'data_ml',
			title: 'Data Science / ML',
			direction: 'data',
			availability: 'enabled',
			summary: 'Статистика, метрики качества, подготовка данных и обучение моделей.',
			practiceLanguages: ['python3']
		},
		{
			key: 'qa',
			title: 'QA',
			direction: 'quality',
			availability: 'enabled',
			summary: 'Тест-дизайн, анализ дефектов, тестирование API и автоматизация проверок.',
			practiceLanguages: ['python3']
		},
		{
			key: 'devops',
			title: 'DevOps / SRE',
			direction: 'infrastructure',
			availability: 'enabled',
			summary: 'Linux и сети, контейнеры и оркестрация, конвейеры поставки, наблюдаемость и надёжность.',
			practiceLanguages: ['python3', 'go']
		}
	],
	grades: [
		{ key: 'intern', ordinal: 0 },
		{ key: 'junior', ordinal: 1 },
		{ key: 'middle', ordinal: 2 },
		{ key: 'senior', ordinal: 3 }
	],
	blocks: [
		// Backend.
		{
			code: 'be.lang',
			specialization: 'backend',
			title: 'Язык и среда исполнения',
			checks: 'Чтение кода: типы и коллекции, области видимости и замыкания, исключения, ссылки и копии.',
			skillKeys: ['oop'],
			formats: ['code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'be.algo',
			specialization: 'backend',
			title: 'Алгоритмы и структуры данных',
			checks: 'Сложность, выбор структуры данных, обход и сортировка с граничными случаями.',
			skillKeys: ['algorithms'],
			formats: ['code_trace', 'compute', 'bug_locate'],
			practice: false
		},
		{
			code: 'be.db',
			specialization: 'backend',
			title: 'Базы данных и SQL',
			checks:
				'Результат запроса на сгенерированных данных: соединения, агрегаты с NULL, группировка, оконные функции, транзакции.',
			skillKeys: ['sql', 'databases'],
			formats: ['sql_trace', 'bug_locate', 'compute'],
			practice: false
		},
		{
			code: 'be.api',
			specialization: 'backend',
			title: 'HTTP и API',
			checks: 'Коды и семантика HTTP, идемпотентность и повтор запросов, пагинация, версионирование, кэширование.',
			skillKeys: ['rest'],
			formats: ['compute', 'code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'be.concurrency',
			specialization: 'backend',
			title: 'Конкурентность и асинхронность',
			checks: 'Порядок выполнения, гонки и блокировки, очереди и повторная доставка сообщений.',
			skillKeys: ['multithreading'],
			formats: ['code_trace', 'bug_locate', 'compute'],
			practice: false
		},
		{
			code: 'be.debug',
			specialization: 'backend',
			title: 'Поиск ошибок и надёжность',
			checks: 'Строка с дефектом в коде сервиса, обработка ошибок и таймаутов, граничные данные.',
			skillKeys: [],
			formats: ['bug_locate', 'code_trace'],
			practice: false
		},
		{
			code: 'be.design',
			specialization: 'backend',
			title: 'Проектирование систем',
			checks: 'Оценка нагрузки и ёмкости, кэш и его инвалидация, согласованность данных, деградация при отказах.',
			skillKeys: ['system_design', 'microservices'],
			formats: ['compute', 'config_eval', 'code_trace'],
			practice: false
		},
		{
			code: 'be.code',
			specialization: 'backend',
			title: 'Практическая задача',
			checks: 'Функция или обработчик по спецификации на выбранном языке; проверка скрытыми параметрическими тестами.',
			skillKeys: [],
			formats: ['practice_code'],
			practice: true
		},
		// Frontend.
		{
			code: 'fe.js',
			specialization: 'frontend',
			title: 'JavaScript и TypeScript',
			checks: 'Чтение кода: замыкания, this и прототипы, приведение типов, сужение типов TypeScript.',
			skillKeys: ['javascript', 'typescript'],
			formats: ['code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'fe.async',
			specialization: 'frontend',
			title: 'Асинхронность и цикл событий',
			checks: 'Порядок вывода микро- и макрозадач, await в цикле против Promise.all, debounce и throttle по таймлайну.',
			skillKeys: ['javascript'],
			formats: ['code_trace', 'compute', 'bug_locate'],
			practice: false
		},
		{
			code: 'fe.dom',
			specialization: 'frontend',
			title: 'HTML, CSS и DOM',
			checks: 'Специфичность селекторов, каскад, всплытие и перехват событий, раскладка блоков.',
			skillKeys: ['html', 'css'],
			formats: ['compute', 'code_trace'],
			practice: false
		},
		{
			code: 'fe.state',
			specialization: 'frontend',
			title: 'Состояние и компоненты',
			checks: 'Переходы состояния по спецификации, неизменяемость, мемоизация и повторный рендер.',
			skillKeys: [],
			formats: ['code_trace', 'bug_locate', 'compute'],
			practice: false
		},
		{
			code: 'fe.web',
			specialization: 'frontend',
			title: 'Сеть и браузер',
			checks: 'Кэширование HTTP, CORS, куки и их атрибуты, разрешение URL.',
			skillKeys: [],
			formats: ['compute', 'config_eval'],
			practice: false
		},
		{
			code: 'fe.perf',
			specialization: 'frontend',
			title: 'Производительность и архитектура',
			checks: 'Стоимость рендера и пересчёта стилей, разбиение сборки, виртуализация списков.',
			skillKeys: [],
			formats: ['compute', 'code_trace', 'config_eval'],
			practice: false
		},
		{
			code: 'fe.code',
			specialization: 'frontend',
			title: 'Практическая задача',
			checks: 'Чистая функция состояния или утилита по спецификации; проверка скрытыми параметрическими тестами.',
			skillKeys: [],
			formats: ['practice_code'],
			practice: true
		},
		// Mobile.
		{
			code: 'mob.kotlin',
			specialization: 'mobile',
			title: 'Kotlin',
			checks: 'Чтение кода: null-безопасность, коллекции, data- и sealed-классы, функции области видимости.',
			skillKeys: ['kotlin'],
			formats: ['code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'mob.coroutines',
			specialization: 'mobile',
			title: 'Корутины и потоки',
			checks: 'Порядок выполнения корутин, структурная конкурентность, отмена и диспетчеры.',
			skillKeys: ['kotlin', 'multithreading'],
			formats: ['code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'mob.lifecycle',
			specialization: 'mobile',
			title: 'Жизненный цикл Android',
			checks: 'Порядок колбэков при смене конфигурации и уничтожении процесса по модели жизненного цикла.',
			skillKeys: ['android'],
			formats: ['compute', 'code_trace'],
			practice: false
		},
		{
			code: 'mob.ui',
			specialization: 'mobile',
			title: 'Интерфейс и состояние',
			checks: 'Перекомпоновка и подъём состояния в декларативном интерфейсе, порядок событий ввода.',
			skillKeys: ['jetpack_compose'],
			formats: ['code_trace', 'compute'],
			practice: false
		},
		{
			code: 'mob.data',
			specialization: 'mobile',
			title: 'Данные и сеть',
			checks: 'Локальное хранение и SQL, кэш и работа без сети, сериализация.',
			skillKeys: ['sqlite'],
			formats: ['sql_trace', 'compute', 'code_trace'],
			practice: false
		},
		{
			code: 'mob.arch',
			specialization: 'mobile',
			title: 'Архитектура приложения',
			checks: 'Граф зависимостей и модулей, навигация и стек экранов, разделение слоёв.',
			skillKeys: [],
			formats: ['compute', 'config_eval', 'code_trace'],
			practice: false
		},
		{
			code: 'mob.code',
			specialization: 'mobile',
			title: 'Практическая задача',
			checks:
				'Логика модели представления или преобразование данных на JVM; проверка скрытыми параметрическими тестами.',
			skillKeys: [],
			formats: ['practice_code'],
			practice: true
		},
		// Data Science / ML.
		{
			code: 'ds.stats',
			specialization: 'data_ml',
			title: 'Статистика и вероятность',
			checks: 'Расчёт оценок, интервалов и критериев на сгенерированных выборках, условные вероятности.',
			skillKeys: ['statistics'],
			formats: ['compute'],
			practice: false
		},
		{
			code: 'ds.metrics',
			specialization: 'data_ml',
			title: 'Метрики качества',
			checks: 'Precision@k, F1, ROC AUC с равными скорами, метрики регрессии и ранжирования по сгенерированным данным.',
			skillKeys: ['ml'],
			formats: ['compute', 'bug_locate'],
			practice: false
		},
		{
			code: 'ds.data',
			specialization: 'data_ml',
			title: 'Подготовка данных',
			checks: 'Трассировка преобразований таблиц: группировка, соединение, пропуски, дубликаты.',
			skillKeys: [],
			formats: ['code_trace', 'compute', 'bug_locate'],
			practice: false
		},
		{
			code: 'ds.ml',
			specialization: 'data_ml',
			title: 'Обучение моделей',
			checks: 'Утечка целевой переменной, порядок fit и transform, кросс-валидация, переобучение.',
			skillKeys: ['ml'],
			formats: ['compute', 'code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'ds.sql',
			specialization: 'data_ml',
			title: 'SQL для анализа',
			checks: 'Результат аналитического запроса: оконные функции, агрегаты с NULL, когорты.',
			skillKeys: ['sql'],
			formats: ['sql_trace'],
			practice: false
		},
		{
			code: 'ds.dl',
			specialization: 'data_ml',
			title: 'Глубокое обучение и эксплуатация моделей',
			checks: 'Размерности тензоров, шаг градиента, дрейф данных и мониторинг модели.',
			skillKeys: ['dl'],
			formats: ['compute', 'code_trace'],
			practice: false
		},
		{
			code: 'ds.code',
			specialization: 'data_ml',
			title: 'Практическая задача',
			checks:
				'Расчёт метрики, разбиение или преобразование данных на Python без сторонних библиотек; проверка скрытыми тестами.',
			skillKeys: [],
			formats: ['practice_code'],
			practice: true
		},
		// QA.
		{
			code: 'qa.design',
			specialization: 'qa',
			title: 'Тест-дизайн',
			checks: 'Классы эквивалентности, граничные значения и комбинации условий по спецификации.',
			skillKeys: ['manual_testing'],
			formats: ['compute'],
			practice: false
		},
		{
			code: 'qa.defects',
			specialization: 'qa',
			title: 'Анализ дефектов',
			checks: 'Какой дефект объясняет лог и расхождение со спецификацией; воспроизведение и локализация.',
			skillKeys: ['manual_testing'],
			formats: ['bug_locate', 'compute'],
			practice: false
		},
		{
			code: 'qa.api',
			specialization: 'qa',
			title: 'Тестирование API',
			checks: 'Ожидаемые коды и тела ответов, идемпотентность, нарушения контракта.',
			skillKeys: ['rest'],
			formats: ['compute', 'config_eval'],
			practice: false
		},
		{
			code: 'qa.auto',
			specialization: 'qa',
			title: 'Автоматизация проверок',
			checks: 'Чтение тестового кода: фикстуры и их порядок, моки, параметризация, нестабильные тесты.',
			skillKeys: ['test_automation', 'pytest'],
			formats: ['code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'qa.sql',
			specialization: 'qa',
			title: 'Данные и SQL для проверок',
			checks: 'Результат проверочного запроса к сгенерированной базе.',
			skillKeys: ['sql'],
			formats: ['sql_trace'],
			practice: false
		},
		{
			code: 'qa.strategy',
			specialization: 'qa',
			title: 'Стратегия тестирования',
			checks: 'Покрытие по рискам, выбор уровня проверки, расчёт покрытия требований.',
			skillKeys: [],
			formats: ['compute', 'config_eval'],
			practice: false
		},
		{
			code: 'qa.mutants',
			specialization: 'qa',
			title: 'Практическая задача: тест-кейсы',
			checks:
				'Набор из 5–8 тест-кейсов по спецификации: сначала проходит на исправной программе, затем ловит её мутантов.',
			skillKeys: ['test_automation'],
			formats: ['qa_mutation'],
			practice: true
		},
		// DevOps / SRE.
		{
			code: 'ops.linux',
			specialization: 'devops',
			title: 'Linux и командная строка',
			checks: 'Вывод конвейера команд на сгенерированных файлах, права и процессы.',
			skillKeys: ['linux', 'bash'],
			formats: ['code_trace', 'bug_locate'],
			practice: false
		},
		{
			code: 'ops.net',
			specialization: 'devops',
			title: 'Сети',
			checks: 'Подсети и маски, маршрутизация, DNS, порты и балансировка.',
			skillKeys: ['networking'],
			formats: ['compute'],
			practice: false
		},
		{
			code: 'ops.containers',
			specialization: 'devops',
			title: 'Контейнеры',
			checks: 'Слои и кэш сборки Dockerfile, порядок инструкций, итоговый образ.',
			skillKeys: ['docker'],
			formats: ['config_eval', 'bug_locate'],
			practice: false
		},
		{
			code: 'ops.k8s',
			specialization: 'devops',
			title: 'Оркестрация',
			checks: 'Разбор манифестов: какие объекты и сколько подов получится, селекторы и ресурсы.',
			skillKeys: ['kubernetes'],
			formats: ['config_eval', 'bug_locate'],
			practice: false
		},
		{
			code: 'ops.cicd',
			specialization: 'devops',
			title: 'Конвейеры поставки',
			checks: 'Порядок и условия заданий конвейера, артефакты и кэш, правила запуска.',
			skillKeys: ['cicd'],
			formats: ['config_eval', 'bug_locate'],
			practice: false
		},
		{
			code: 'ops.observability',
			specialization: 'devops',
			title: 'Наблюдаемость и надёжность',
			checks: 'Расчёт SLO и бюджета ошибок, срабатывание правил оповещения, запросы к метрикам.',
			skillKeys: ['prometheus'],
			formats: ['compute', 'config_eval'],
			practice: false
		},
		{
			code: 'ops.iac',
			specialization: 'devops',
			title: 'Инфраструктура как код',
			checks: 'План изменений описания инфраструктуры: что создаётся, меняется и удаляется.',
			skillKeys: ['terraform'],
			formats: ['config_eval'],
			practice: false
		},
		{
			code: 'ops.code',
			specialization: 'devops',
			title: 'Практическая задача',
			checks: 'Скрипт разбора конфигурации или журнала по спецификации; проверка скрытыми параметрическими тестами.',
			skillKeys: [],
			formats: ['practice_code'],
			practice: true
		}
	],
	definitions: [
		// Backend.
		{
			specialization: 'backend',
			grade: 'intern',
			defining: ['be.lang', 'be.db'],
			borderline: 'Уверенно читает короткий код на одном языке и простые SELECT; ошибается на граничных данных и NULL.',
			expects: [
				'предсказывает вывод программы из 10–20 строк',
				'пишет функцию по спецификации с подсказкой граничных случаев',
				'понимает результат простого запроса с WHERE и ORDER BY'
			],
			blocks: [
				{ block: 'be.lang', items: 5 },
				{ block: 'be.algo', items: 3 },
				{ block: 'be.db', items: 4 },
				{ block: 'be.debug', items: 4 },
				{ block: 'be.api', items: 1 },
				{ block: 'be.code', items: 1 }
			],
			practice: { block: 'be.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: []
		},
		{
			specialization: 'backend',
			grade: 'junior',
			defining: ['be.db', 'be.api'],
			borderline:
				'Самостоятельно пишет обработчик по ясной спецификации и запрос с JOIN; ошибается в идемпотентности и NULL в агрегатах.',
			expects: [
				'находит строку с дефектом в коде сервиса',
				'предсказывает результат запроса с JOIN и GROUP BY',
				'выбирает код ответа HTTP и поведение при повторе запроса'
			],
			blocks: [
				{ block: 'be.lang', items: 4 },
				{ block: 'be.algo', items: 3 },
				{ block: 'be.db', items: 4 },
				{ block: 'be.api', items: 3 },
				{ block: 'be.debug', items: 3 },
				{ block: 'be.code', items: 1 }
			],
			practice: { block: 'be.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: []
		},
		{
			specialization: 'backend',
			grade: 'middle',
			defining: ['be.db', 'be.concurrency'],
			borderline:
				'Уверенно работает с транзакциями, конкурентным доступом и повтором сообщений; ошибается в редких гонках и оценке нагрузки.',
			expects: [
				'находит гонку или взаимную блокировку в коде',
				'предсказывает результат оконных функций и транзакций',
				'меняет своё решение под новое существенное условие'
			],
			blocks: [
				{ block: 'be.lang', items: 2 },
				{ block: 'be.algo', items: 2 },
				{ block: 'be.db', items: 4 },
				{ block: 'be.api', items: 3 },
				{ block: 'be.concurrency', items: 3 },
				{ block: 'be.debug', items: 3 },
				{ block: 'be.code', items: 1 }
			],
			practice: { block: 'be.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: []
		},
		{
			specialization: 'backend',
			grade: 'senior',
			defining: ['be.concurrency', 'be.design'],
			borderline:
				'Оценивает ёмкость и согласованность системы и выбирает поведение при отказах; ошибается в редких сочетаниях отказов.',
			expects: [
				'оценивает нагрузку, ёмкость кэша и очереди по условиям',
				'определяет поведение системы при отказе зависимости',
				'меняет решение под новое ограничение без потери корректности'
			],
			blocks: [
				{ block: 'be.db', items: 3 },
				{ block: 'be.api', items: 3 },
				{ block: 'be.concurrency', items: 4 },
				{ block: 'be.debug', items: 2 },
				{ block: 'be.design', items: 5 },
				{ block: 'be.code', items: 1 }
			],
			practice: { block: 'be.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: [...SENIOR_DOES_NOT_CHECK]
		},
		// Frontend.
		{
			specialization: 'frontend',
			grade: 'intern',
			defining: ['fe.js', 'fe.dom'],
			borderline:
				'Читает короткий код на JavaScript и простую разметку; путается в this и порядке асинхронного вывода.',
			expects: [
				'предсказывает вывод короткой программы на JavaScript',
				'определяет, какое правило CSS применится',
				'пишет чистую функцию по спецификации'
			],
			blocks: [
				{ block: 'fe.js', items: 6 },
				{ block: 'fe.async', items: 4 },
				{ block: 'fe.dom', items: 4 },
				{ block: 'fe.state', items: 3 },
				{ block: 'fe.code', items: 1 }
			],
			practice: { block: 'fe.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: []
		},
		{
			specialization: 'frontend',
			grade: 'junior',
			defining: ['fe.js', 'fe.async'],
			borderline:
				'Уверенно работает с промисами и состоянием компонента; ошибается в порядке микро- и макрозадач и в кэшировании.',
			expects: [
				'предсказывает порядок вывода при await и setTimeout',
				'находит ошибку в обработчике состояния',
				'определяет поведение запроса при CORS и куках'
			],
			blocks: [
				{ block: 'fe.js', items: 4 },
				{ block: 'fe.async', items: 4 },
				{ block: 'fe.dom', items: 3 },
				{ block: 'fe.state', items: 3 },
				{ block: 'fe.web', items: 3 },
				{ block: 'fe.code', items: 1 }
			],
			practice: { block: 'fe.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: []
		},
		{
			specialization: 'frontend',
			grade: 'middle',
			defining: ['fe.async', 'fe.state'],
			borderline:
				'Предсказывает поведение асинхронного кода и повторного рендера; ошибается в редких гонках запросов и стоимости рендера.',
			expects: [
				'находит гонку запросов в интерфейсе',
				'определяет лишние перерисовки и их причину',
				'меняет своё решение под новое существенное условие'
			],
			blocks: [
				{ block: 'fe.js', items: 3 },
				{ block: 'fe.async', items: 4 },
				{ block: 'fe.dom', items: 2 },
				{ block: 'fe.state', items: 4 },
				{ block: 'fe.web', items: 2 },
				{ block: 'fe.perf', items: 2 },
				{ block: 'fe.code', items: 1 }
			],
			practice: { block: 'fe.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: []
		},
		{
			specialization: 'frontend',
			grade: 'senior',
			defining: ['fe.async', 'fe.perf'],
			borderline:
				'Оценивает производительность и архитектуру клиентской части по условиям; ошибается в редких сочетаниях кэша и сети.',
			expects: [
				'оценивает стоимость рендера и выбирает способ её снизить',
				'определяет поведение приложения при сбоях сети и кэша',
				'меняет решение под новое ограничение без потери корректности'
			],
			blocks: [
				{ block: 'fe.js', items: 2 },
				{ block: 'fe.async', items: 4 },
				{ block: 'fe.state', items: 3 },
				{ block: 'fe.web', items: 3 },
				{ block: 'fe.perf', items: 5 },
				{ block: 'fe.code', items: 1 }
			],
			practice: { block: 'fe.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: [...SENIOR_DOES_NOT_CHECK]
		},
		// Mobile.
		{
			specialization: 'mobile',
			grade: 'intern',
			defining: ['mob.kotlin', 'mob.lifecycle'],
			borderline: 'Читает короткий код на Kotlin; путается в null-безопасности и порядке колбэков экрана.',
			expects: [
				'предсказывает вывод короткой программы на Kotlin',
				'называет порядок колбэков при открытии экрана',
				'пишет функцию преобразования данных по спецификации'
			],
			blocks: [
				{ block: 'mob.kotlin', items: 7 },
				{ block: 'mob.lifecycle', items: 3 },
				{ block: 'mob.ui', items: 4 },
				{ block: 'mob.data', items: 3 },
				{ block: 'mob.code', items: 1 }
			],
			practice: { block: 'mob.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Работу на настоящем устройстве и в Android Studio']
		},
		{
			specialization: 'mobile',
			grade: 'junior',
			defining: ['mob.kotlin', 'mob.lifecycle'],
			borderline:
				'Уверенно работает с коллекциями Kotlin и жизненным циклом экрана; ошибается при смене конфигурации и отмене корутин.',
			expects: [
				'предсказывает порядок колбэков при повороте экрана',
				'находит ошибку обращения к null или к уничтоженному экрану',
				'предсказывает результат запроса к локальной базе'
			],
			blocks: [
				{ block: 'mob.kotlin', items: 5 },
				{ block: 'mob.coroutines', items: 3 },
				{ block: 'mob.lifecycle', items: 4 },
				{ block: 'mob.ui', items: 3 },
				{ block: 'mob.data', items: 2 },
				{ block: 'mob.code', items: 1 }
			],
			practice: { block: 'mob.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Работу на настоящем устройстве и в Android Studio']
		},
		{
			specialization: 'mobile',
			grade: 'middle',
			defining: ['mob.coroutines', 'mob.data'],
			borderline:
				'Предсказывает поведение корутин и состояния при уничтожении процесса; ошибается в редких гонках и в кэше без сети.',
			expects: [
				'предсказывает порядок выполнения корутин с отменой',
				'определяет, что переживёт уничтожение процесса',
				'меняет своё решение под новое существенное условие'
			],
			blocks: [
				{ block: 'mob.kotlin', items: 3 },
				{ block: 'mob.coroutines', items: 4 },
				{ block: 'mob.lifecycle', items: 3 },
				{ block: 'mob.ui', items: 3 },
				{ block: 'mob.data', items: 3 },
				{ block: 'mob.arch', items: 1 },
				{ block: 'mob.code', items: 1 }
			],
			practice: { block: 'mob.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Работу на настоящем устройстве и в Android Studio']
		},
		{
			specialization: 'mobile',
			grade: 'senior',
			defining: ['mob.coroutines', 'mob.arch'],
			borderline:
				'Выбирает архитектуру модулей и поведение приложения без сети; ошибается в редких сочетаниях жизненного цикла и данных.',
			expects: [
				'определяет граф зависимостей и его ошибки',
				'выбирает стратегию синхронизации данных без сети',
				'меняет решение под новое ограничение без потери корректности'
			],
			blocks: [
				{ block: 'mob.kotlin', items: 2 },
				{ block: 'mob.coroutines', items: 4 },
				{ block: 'mob.lifecycle', items: 2 },
				{ block: 'mob.data', items: 4 },
				{ block: 'mob.arch', items: 5 },
				{ block: 'mob.code', items: 1 }
			],
			practice: { block: 'mob.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Работу на настоящем устройстве и в Android Studio', ...SENIOR_DOES_NOT_CHECK]
		},
		// Data Science / ML.
		{
			specialization: 'data_ml',
			grade: 'intern',
			defining: ['ds.stats', 'ds.metrics'],
			borderline:
				'Считает базовые статистики и простые метрики; путается в условных вероятностях и метриках при дисбалансе.',
			expects: [
				'считает среднее, медиану, дисперсию и долю на выборке',
				'считает precision, recall и F1 по матрице ошибок',
				'пишет расчёт метрики на Python по спецификации'
			],
			blocks: [
				{ block: 'ds.stats', items: 5 },
				{ block: 'ds.metrics', items: 4 },
				{ block: 'ds.data', items: 5 },
				{ block: 'ds.sql', items: 3 },
				{ block: 'ds.code', items: 1 }
			],
			practice: { block: 'ds.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с библиотеками машинного обучения и GPU']
		},
		{
			specialization: 'data_ml',
			grade: 'junior',
			defining: ['ds.metrics', 'ds.data'],
			borderline:
				'Уверенно считает метрики и готовит данные; ошибается в утечке целевой переменной и в метриках с равными скорами.',
			expects: [
				'считает ROC AUC и precision@k на сгенерированных скорах',
				'предсказывает результат группировки и соединения таблиц',
				'находит утечку целевой переменной в конвейере'
			],
			blocks: [
				{ block: 'ds.stats', items: 3 },
				{ block: 'ds.metrics', items: 4 },
				{ block: 'ds.data', items: 4 },
				{ block: 'ds.ml', items: 3 },
				{ block: 'ds.sql', items: 3 },
				{ block: 'ds.code', items: 1 }
			],
			practice: { block: 'ds.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с библиотеками машинного обучения и GPU']
		},
		{
			specialization: 'data_ml',
			grade: 'middle',
			defining: ['ds.ml', 'ds.stats'],
			borderline:
				'Строит корректную схему валидации и выбирает метрику под задачу; ошибается в редких видах утечки и сдвига данных.',
			expects: [
				'определяет корректную схему кросс-валидации для данных',
				'находит причину расхождения офлайн- и онлайн-метрик',
				'меняет своё решение под новое существенное условие'
			],
			blocks: [
				{ block: 'ds.stats', items: 3 },
				{ block: 'ds.metrics', items: 3 },
				{ block: 'ds.data', items: 3 },
				{ block: 'ds.ml', items: 5 },
				{ block: 'ds.sql', items: 2 },
				{ block: 'ds.dl', items: 1 },
				{ block: 'ds.code', items: 1 }
			],
			practice: { block: 'ds.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с библиотеками машинного обучения и GPU']
		},
		{
			specialization: 'data_ml',
			grade: 'senior',
			defining: ['ds.ml', 'ds.dl'],
			borderline:
				'Выбирает постановку, метрику и мониторинг модели в эксплуатации; ошибается в редких сочетаниях дрейфа и обратной связи.',
			expects: [
				'определяет дрейф данных и его влияние на метрику',
				'проверяет размерности и шаг обучения сети',
				'меняет решение под новое ограничение без потери корректности'
			],
			blocks: [
				{ block: 'ds.stats', items: 3 },
				{ block: 'ds.metrics', items: 2 },
				{ block: 'ds.ml', items: 5 },
				{ block: 'ds.sql', items: 2 },
				{ block: 'ds.dl', items: 5 },
				{ block: 'ds.code', items: 1 }
			],
			practice: { block: 'ds.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с библиотеками машинного обучения и GPU', ...SENIOR_DOES_NOT_CHECK]
		},
		// QA.
		{
			specialization: 'qa',
			grade: 'intern',
			defining: ['qa.design', 'qa.defects'],
			borderline: 'Выделяет очевидные классы эквивалентности и читает простой лог; пропускает граничные значения.',
			expects: [
				'выделяет классы эквивалентности по спецификации',
				'находит расхождение лога со спецификацией',
				'составляет набор тест-кейсов, который проходит на исправной программе'
			],
			blocks: [
				{ block: 'qa.design', items: 6 },
				{ block: 'qa.defects', items: 5 },
				{ block: 'qa.api', items: 4 },
				{ block: 'qa.sql', items: 2 },
				{ block: 'qa.mutants', items: 1 }
			],
			practice: { block: 'qa.mutants', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с конкретной системой управления тестированием']
		},
		{
			specialization: 'qa',
			grade: 'junior',
			defining: ['qa.design', 'qa.defects'],
			borderline:
				'Уверенно применяет граничные значения и проверяет API по контракту; ошибается в комбинациях условий.',
			expects: [
				'выбирает граничные значения для нескольких условий',
				'определяет ожидаемый ответ API и нарушение контракта',
				'составляет 5–8 тест-кейсов, ловящих мутантов программы'
			],
			blocks: [
				{ block: 'qa.design', items: 5 },
				{ block: 'qa.defects', items: 4 },
				{ block: 'qa.api', items: 3 },
				{ block: 'qa.auto', items: 3 },
				{ block: 'qa.sql', items: 2 },
				{ block: 'qa.mutants', items: 1 }
			],
			practice: { block: 'qa.mutants', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с конкретной системой управления тестированием']
		},
		{
			specialization: 'qa',
			grade: 'middle',
			defining: ['qa.auto', 'qa.design'],
			borderline:
				'Строит экономный набор проверок для сложной логики и автоматизирует его; ошибается в нестабильных тестах и редких сочетаниях.',
			expects: [
				'находит причину нестабильного теста',
				'строит экономный набор проверок для комбинаций условий',
				'меняет свой набор тест-кейсов под новое существенное условие'
			],
			blocks: [
				{ block: 'qa.design', items: 4 },
				{ block: 'qa.defects', items: 3 },
				{ block: 'qa.api', items: 3 },
				{ block: 'qa.auto', items: 4 },
				{ block: 'qa.sql', items: 2 },
				{ block: 'qa.strategy', items: 1 },
				{ block: 'qa.mutants', items: 1 }
			],
			practice: { block: 'qa.mutants', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с конкретной системой управления тестированием']
		},
		{
			specialization: 'qa',
			grade: 'senior',
			defining: ['qa.strategy', 'qa.auto'],
			borderline: 'Выбирает стратегию проверки по рискам и уровням тестирования; ошибается в редких сочетаниях рисков.',
			expects: [
				'распределяет проверки по рискам и уровням',
				'оценивает покрытие требований набором проверок',
				'меняет набор тест-кейсов под новое ограничение без потери силы'
			],
			blocks: [
				{ block: 'qa.design', items: 3 },
				{ block: 'qa.defects', items: 3 },
				{ block: 'qa.api', items: 2 },
				{ block: 'qa.auto', items: 4 },
				{ block: 'qa.strategy', items: 5 },
				{ block: 'qa.mutants', items: 1 }
			],
			practice: { block: 'qa.mutants', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Работу с конкретной системой управления тестированием', ...SENIOR_DOES_NOT_CHECK]
		},
		// DevOps / SRE.
		{
			specialization: 'devops',
			grade: 'intern',
			defining: ['ops.linux', 'ops.net'],
			borderline: 'Читает простые команды и Dockerfile; путается в масках подсетей и кэше слоёв.',
			expects: [
				'предсказывает вывод конвейера из двух-трёх команд',
				'определяет, попадает ли адрес в подсеть',
				'пишет скрипт разбора журнала по спецификации'
			],
			blocks: [
				{ block: 'ops.linux', items: 6 },
				{ block: 'ops.net', items: 4 },
				{ block: 'ops.containers', items: 5 },
				{ block: 'ops.cicd', items: 2 },
				{ block: 'ops.code', items: 1 }
			],
			practice: { block: 'ops.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Доступ к настоящей облачной инфраструктуре и кластеру']
		},
		{
			specialization: 'devops',
			grade: 'junior',
			defining: ['ops.containers', 'ops.k8s'],
			borderline:
				'Уверенно собирает образ и описывает простой конвейер; ошибается в селекторах манифестов и условиях запуска заданий.',
			expects: [
				'определяет, какие слои образа пересоберутся',
				'определяет, какие объекты создаст манифест',
				'определяет порядок и условия заданий конвейера'
			],
			blocks: [
				{ block: 'ops.linux', items: 4 },
				{ block: 'ops.net', items: 3 },
				{ block: 'ops.containers', items: 4 },
				{ block: 'ops.k8s', items: 3 },
				{ block: 'ops.cicd', items: 3 },
				{ block: 'ops.code', items: 1 }
			],
			practice: { block: 'ops.code', position: 4, changeStep: false, gateMinScore: 0.4 },
			doesNotCheck: ['Доступ к настоящей облачной инфраструктуре и кластеру']
		},
		{
			specialization: 'devops',
			grade: 'middle',
			defining: ['ops.k8s', 'ops.observability'],
			borderline: 'Предсказывает поведение оркестратора и оповещений; ошибается в редких сочетаниях ресурсов и правил.',
			expects: [
				'определяет, сколько подов и где запустится при ограничениях',
				'считает бюджет ошибок и срабатывание оповещения',
				'меняет своё решение под новое существенное условие'
			],
			blocks: [
				{ block: 'ops.linux', items: 2 },
				{ block: 'ops.net', items: 2 },
				{ block: 'ops.containers', items: 2 },
				{ block: 'ops.k8s', items: 4 },
				{ block: 'ops.cicd', items: 3 },
				{ block: 'ops.observability', items: 4 },
				{ block: 'ops.code', items: 1 }
			],
			practice: { block: 'ops.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Доступ к настоящей облачной инфраструктуре и кластеру']
		},
		{
			specialization: 'devops',
			grade: 'senior',
			defining: ['ops.iac', 'ops.observability'],
			borderline:
				'Планирует изменения инфраструктуры и надёжность сервиса по SLO; ошибается в редких сочетаниях отказов.',
			expects: [
				'определяет, что изменит и удалит план инфраструктуры',
				'выбирает SLO и правила оповещения под условия',
				'меняет решение под новое ограничение без потери корректности'
			],
			blocks: [
				{ block: 'ops.net', items: 2 },
				{ block: 'ops.k8s', items: 4 },
				{ block: 'ops.cicd', items: 2 },
				{ block: 'ops.observability', items: 4 },
				{ block: 'ops.iac', items: 5 },
				{ block: 'ops.code', items: 1 }
			],
			practice: { block: 'ops.code', position: 4, changeStep: true, gateMinScore: 0.4 },
			doesNotCheck: ['Доступ к настоящей облачной инфраструктуре и кластеру', ...SENIOR_DOES_NOT_CHECK]
		}
	],
	commonDoesNotCheck: [
		'Коммерческий опыт и его длительность',
		'Работу в команде и коммуникацию',
		'Самостоятельность выполнения: тест проходит без надзора',
		'Навыки за пределами блоков этого теста'
	]
};

/** The definition of a pair; every pair of the catalog has exactly one (checked by the validator). */
export function gradeDefinition(specialization: SpecializationKey, grade: GradeKey): GradeDefinition {
	const found = CATALOG.definitions.find((d) => d.specialization === specialization && d.grade === grade);
	if (!found) throw new Error(`catalog ${CATALOG.version} has no definition for ${specialization} × ${grade}`);
	return found;
}

/** Whether the practice of a grade is code the candidate writes (`practice_code`), so its language is theirs. */
export function practiceWritesCode(definition: GradeDefinition): boolean {
	return blockDefinition(definition.practice.block).formats.includes('practice_code');
}

/**
 * The confirmed stack of a confirmed decision: the skills of the grade's defining blocks and, when the candidate wrote
 * the practice program, the skill of its language. A QA practice (`qa_mutation`) is test cases run by a harness in a
 * language the candidate never wrote: no language is confirmed (`practiceLanguage` is `null`). It does not depend on how
 * long the attempt ran: every confirmation has seen the defining blocks in full.
 */
export function confirmedStack(definition: GradeDefinition, practiceLanguage: PracticeLanguageKey | null): string[] {
	if (practiceLanguage !== null && !practiceWritesCode(definition)) {
		throw new Error(
			`${definition.specialization} × ${definition.grade}: the practice is not code the candidate writes, no language is confirmed`
		);
	}
	const skills = new Set<string>(practiceLanguage === null ? [] : [PRACTICE_LANGUAGE_SKILLS[practiceLanguage]]);
	for (const code of definition.defining) for (const skill of blockDefinition(code).skillKeys) skills.add(skill);
	return [...skills].sort();
}

/** The block by its code. */
export function blockDefinition(code: string): BlockDefinition {
	const found = CATALOG.blocks.find((b) => b.code === code);
	if (!found) throw new Error(`catalog ${CATALOG.version} has no block ${code}`);
	return found;
}

export function gradeOrdinal(grade: GradeKey): number {
	return GRADE_KEYS.indexOf(grade);
}

/**
 * Whether a specialization is open: switched on in the catalog and with a released bank. Every place that offers or
 * accepts a specialization asks this one predicate (domain 10.5).
 */
export function specializationOpen(
	specialization: SpecializationKey,
	releasedSpecializations: ReadonlySet<SpecializationKey>
): boolean {
	const definition = CATALOG.specializations.find((s) => s.key === specialization);
	return definition?.availability === 'enabled' && releasedSpecializations.has(specialization);
}
