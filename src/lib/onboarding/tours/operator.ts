import { navItem, testId, tourTarget, TOUR_BUTTON, type WorkspaceTour } from '../types.js';

// Selectors point at marks the pages already carry: test ids, heading ids and data attributes of the rows.

export const operatorTour: WorkspaceTour = {
	workspace: 'operator',
	welcome: {
		title: 'Здравствуйте!',
		body: 'Здесь очереди проверок со сроками и карьерный лифт федерации в цифрах. Покажем, где что, — меньше минуты.'
	},
	main: [
		{
			href: null,
			target: TOUR_BUTTON,
			title: 'Подсказки — здесь',
			body: 'Этот туториал можно повторить здесь. А ещё у каждой страницы есть свой тур. Покажем, как пользоваться кабинетом.'
		},
		{
			// The overview is not a navigation item: the stop frames its queues.
			href: '/operator',
			target: '#queues-heading',
			title: 'Обзор',
			body: 'Все очереди со сроками на одном экране и карьерный лифт федерации.'
		},
		{
			href: '/operator/companies',
			target: navItem('/operator/companies'),
			title: 'Компании',
			body: 'Заявки работодателей на проверку и список всех компаний платформы.'
		},
		{
			href: '/operator/objections',
			target: navItem('/operator/objections'),
			title: 'Возражения',
			body: 'Возражения кандидатов против решения теста о грейде: ответ — в течение 30 дней.'
		},
		{
			href: '/operator/representatives',
			target: navItem('/operator/representatives'),
			title: 'Представители',
			body: 'Профиль кандидата 14–17 лет откроется, когда вы проверите полномочия его представителя.'
		},
		{
			href: '/operator/vacancies',
			target: navItem('/operator/vacancies'),
			title: 'Вакансии',
			body: 'Вакансии, в которых проверка текста нашла недопустимые требования, ждут вашего решения.'
		},
		{
			href: '/operator/outcomes',
			target: navItem('/operator/outcomes'),
			title: 'Исходы',
			body: 'Воронка участников федерации: от приглашения работодателя до выхода на работу.'
		},
		{
			href: '/operator/partnerships',
			target: navItem('/operator/partnerships'),
			title: 'Партнёрства',
			body: 'Партнёры соревнований получают пул совершеннолетних участников по их согласию.'
		},
		{
			href: '/operator/skills',
			target: navItem('/operator/skills'),
			title: 'Навыки',
			body: 'Что требуют вакансии и что подтверждают результаты соревнований ФСП.'
		},
		{
			href: '/operator/fsp-import',
			target: navItem('/operator/fsp-import'),
			title: 'Импорт',
			body: 'Загрузка выгрузок и протоколов соревнований с проверкой пакета до записи.'
		},
		{
			href: '/operator/audit',
			target: navItem('/operator/audit'),
			permission: 'audit.read',
			title: 'Журнал',
			body: 'Кто, что и когда сделал на платформе — без адресов, контактов и текстов.'
		}
	],
	pages: [
		{
			route: '/operator',
			title: 'Обзор',
			steps: [
				{
					target: '[data-queue]',
					title: 'Очереди',
					body: 'Начните с очереди, где срок ближе: карточка ведёт прямо к делам.'
				},
				{
					target: '#analytics-heading',
					title: 'Карьерный лифт',
					body: 'Сколько участников ФСП дошли до работы и каких навыков им не хватает.'
				}
			]
		},
		{
			route: '/operator/companies',
			title: 'Проверка компаний',
			steps: [
				{
					target: testId('queue-filters'),
					title: 'Фильтры',
					body: 'Отберите заявки по способу подтверждения и ответу реестра.'
				},
				{
					target: testId('verification-queue'),
					title: 'Очередь заявок',
					body: 'Откройте заявку, чтобы сверить реквизиты с реестром и принять решение.'
				},
				{
					target: testId('company-directory'),
					title: 'Все компании',
					body: 'Найдите любую компанию, чтобы открыть партнёрство или приостановить её.'
				}
			]
		},
		{
			route: '/operator/companies/requests/[id]',
			title: 'Заявка компании',
			steps: [
				{
					target: testId('registry-state'),
					title: 'Реестр',
					body: 'Ответ реестра — подсказка с источником и временем, а не доказательство полномочий.'
				},
				{
					target: testId('evidence'),
					title: 'Полномочия заявителя',
					body: 'Проверьте приложенный документ или домен рабочей почты заявителя.'
				},
				{
					target: testId('approve-form'),
					title: 'Подтвердить компанию',
					body: 'Сверьте наименование, ОГРН и КПП с реестром и подтвердите компанию.'
				},
				{
					target: testId('reject-form'),
					title: 'Уточнение или отказ',
					body: 'Не хватает данных — запросите уточнение; полномочий нет — отклоните с причиной.'
				}
			]
		},
		{
			route: '/operator/companies/[id]',
			title: 'Компания',
			steps: [
				{
					target: testId('partnership-form'),
					title: 'Открыть партнёрство',
					body: 'Свяжите проверенную компанию с соревнованием — она получит пул его участников.'
				},
				{
					target: testId('suspend-form'),
					title: 'Модерация',
					body: 'Приостановите компанию при нарушениях, указав причину.'
				}
			]
		},
		{
			route: '/operator/objections',
			title: 'Возражения',
			steps: [
				{
					target: testId('objection-queue'),
					title: 'Открытые возражения',
					body: 'Откройте возражение и ответьте кандидату в течение 30 дней.'
				}
			]
		},
		{
			route: '/operator/objections/[id]',
			title: 'Возражение',
			steps: [
				{
					target: testId('objection-reason'),
					title: 'Что пишет кандидат',
					body: 'Прочитайте довод кандидата рядом с оспариваемым решением теста.'
				},
				{
					target: testId('answer-form'),
					title: 'Ответ',
					body: 'Оставьте решение, аннулируйте попытку или пересчитайте оценку — и объясните кандидату.'
				}
			]
		},
		{
			route: '/operator/complaints',
			title: 'Жалобы',
			steps: [
				{
					target: testId('complaint-queue'),
					title: 'Открытые жалобы',
					body: 'Жалобы кандидатов на предложения компаний: откройте, чтобы принять решение.'
				}
			]
		},
		{
			route: '/operator/complaints/[id]',
			title: 'Жалоба',
			steps: [
				{
					target: testId('complaint-text'),
					title: 'Что пишет кандидат',
					body: 'Сравните жалобу с условиями предложения и карточкой компании.'
				},
				{
					target: tourTarget('complaint-decision'),
					title: 'Решение',
					body: 'Выберите исход и объясните его кандидату — компании уйдёт только причина.'
				}
			]
		},
		{
			route: '/operator/representatives',
			title: 'Представители',
			steps: [
				{
					target: testId('representation-queue'),
					title: 'Заявки представителей',
					body: 'Откройте заявку, чтобы проверить полномочия законного представителя.'
				}
			]
		},
		{
			route: '/operator/representatives/[id]',
			title: 'Полномочия представителя',
			steps: [
				{
					target: testId('candidate-age'),
					title: 'Кандидат',
					body: 'Возраст кандидата решает, нужно ли согласие представителя.'
				},
				{
					target: testId('authority-form'),
					title: 'Решение',
					body: 'Укажите основание и подтвердите полномочия — или откажите с причиной.'
				}
			]
		},
		{
			route: '/operator/ages',
			title: 'Конфликты возраста',
			steps: [
				{
					target: testId('age-queue'),
					title: 'Конфликты даты рождения',
					body: 'Год рождения из ФСП не совпал с указанным: откройте случай и сверьте документ.'
				}
			]
		},
		{
			route: '/operator/ages/[id]',
			title: 'Дата рождения',
			steps: [
				{
					target: testId('declared-date'),
					title: 'Что расходится',
					body: 'Сравните дату кандидата с годом рождения из ФСП.'
				},
				{
					target: testId('age-form'),
					title: 'Решение',
					body: 'Запишите дату из документа — возраст подтвердится и профиль откроется.'
				}
			]
		},
		{
			route: '/operator/vacancies',
			title: 'Модерация вакансий',
			steps: [
				{
					target: '[data-moderation]',
					title: 'Вакансии на модерации',
					body: 'Откройте вакансию, чтобы увидеть, какие требования нашла проверка текста.'
				}
			]
		},
		{
			route: '/operator/vacancies/[id]',
			title: 'Вакансия на модерации',
			steps: [
				{
					target: '[data-finding]',
					title: 'Что нашла проверка',
					body: 'Часть таких требований законна — например, гражданство для допуска к гостайне.'
				},
				{
					target: testId('moderation-form'),
					title: 'Решение',
					body: 'Опубликуйте вакансию, верните на правку или отклоните с причиной.'
				},
				{
					target: testId('moderation-history'),
					title: 'История',
					body: 'Все прежние решения по вакансии — по порядку.'
				}
			]
		},
		{
			route: '/operator/assessments',
			title: 'Попытки тестов',
			steps: [
				{
					target: testId('attempt-list'),
					title: 'Попытки',
					body: 'Откройте попытку, чтобы пересмотреть её по сохранённым заданиям и ответам.'
				}
			]
		},
		{
			route: '/operator/assessments/[id]',
			title: 'Попытка теста',
			steps: [
				{
					target: testId('review-decision'),
					title: 'Решение теста',
					body: 'Почему тест поставил этот грейд: баллы и пороги по каждому блоку.'
				},
				{
					target: testId('review-item'),
					title: 'Задания и ответы',
					body: 'Пересмотрите сохранённые задания и ответы сами: сигналы — повод посмотреть, а не вывод.'
				}
			]
		},
		{
			route: '/operator/partnerships',
			title: 'Партнёрства',
			steps: [
				{
					target: '#partnerships-heading',
					title: 'Партнёрства',
					body: 'Действующие партнёрства и соревнования, результаты которых уже на платформе.'
				},
				{
					target: testId('partnership-form'),
					title: 'Открыть партнёрство',
					body: 'Свяжите проверенную компанию с соревнованием — по умолчанию она получит пул финалистов.'
				}
			]
		},
		{
			route: '/operator/outcomes',
			title: 'Карьерные исходы',
			steps: [
				{
					target: testId('funnel-filters'),
					title: 'Разрез',
					body: 'Выберите период, дисциплину, уровень или регион и нажмите «Показать».'
				},
				{
					target: testId('funnel-stages'),
					title: 'Воронка',
					body: 'Сколько участников дошли до собеседования, предложения и выхода на работу.'
				}
			]
		},
		{
			route: '/operator/skills',
			title: 'Навыки рынка ↔ навыки ФСП',
			steps: [
				{
					target: '#skills-window',
					title: 'Окно вакансий',
					body: 'Выберите, за сколько дней учитывать вакансии.'
				},
				{
					target: testId('skills-table'),
					title: 'Сопоставление',
					body: 'Каких востребованных навыков не хватает участникам — подсказка для дисциплин и кейсов.'
				}
			]
		},
		{
			route: '/operator/fsp-import',
			title: 'Импорт результатов ФСП',
			steps: [
				{
					target: testId('batch-form'),
					title: 'Пакет результатов',
					body: 'Загрузите выгрузку или протокол и нажмите «Проверить пакет» — ничего не запишется без вас.'
				},
				{
					target: testId('batch-preview'),
					title: 'Предпросмотр',
					body: 'Проверьте строки с ошибками и куда попадут результаты, затем «Загрузить пакет».'
				},
				{
					target: testId('batch-history'),
					title: 'История загрузок',
					body: 'Прошлые пакеты и что каждый из них изменил в профилях.'
				}
			]
		},
		{
			route: '/operator/audit',
			title: 'Журнал действий',
			steps: [
				{
					target: testId('journal-filters'),
					title: 'Фильтры',
					body: 'Найдите событие по типу, исходу, актору или объекту.'
				},
				{
					target: testId('journal'),
					title: 'События',
					body: 'Каждое действие записано с актором и объектом, а чтение журнала тоже попадает в журнал.'
				}
			]
		}
	]
};
