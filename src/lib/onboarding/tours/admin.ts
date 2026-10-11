import { navItem, testId, tourTarget, TOUR_BUTTON, type WorkspaceTour } from '../types.js';

// Selectors point at marks the pages already carry: test ids, heading ids and data attributes of the blocks.

export const adminTour: WorkspaceTour = {
	workspace: 'admin',
	welcome: {
		title: 'Здравствуйте!',
		body: 'Здесь модели, справочники, банк заданий и персонал платформы. Покажем, где что, — меньше минуты.'
	},
	main: [
		{
			href: null,
			target: TOUR_BUTTON,
			title: 'Подсказки — здесь',
			body: 'Этот туториал можно повторить здесь. А ещё у каждой страницы есть свой тур. Покажем, как пользоваться кабинетом.'
		},
		{
			// The overview is not a navigation item: the stop frames its models section.
			href: '/admin',
			target: '#models-heading',
			title: 'Модели',
			body: 'Режим работы моделей и состояние интеграций на одном экране.'
		},
		{
			href: '/admin/taxonomy',
			target: navItem('/admin/taxonomy'),
			title: 'Справочники',
			body: 'Версии справочника ролей, навыков с синонимами, грейдов и форматов работы.'
		},
		{
			href: '/admin/rules',
			target: navItem('/admin/rules'),
			title: 'Правила',
			body: 'Правила категоризации и соответствия и то, какие навыки подтверждает результат ФСП.'
		},
		{
			href: '/admin/quality',
			target: navItem('/admin/quality'),
			title: 'Качество моделей',
			body: 'Замеры разбора и подбора на размеченной выборке с порогами, заданными заранее.'
		},
		{
			href: '/admin/policies',
			target: navItem('/admin/policies'),
			title: 'Политики',
			body: 'Параметры правил продукта по версиям — у каждого видно основание.'
		},
		{
			href: '/admin/bank',
			target: navItem('/admin/bank'),
			title: 'Задания',
			body: 'Банк заданий тестов: выпуски по специализациям и проверка каждого семейства.'
		},
		{
			href: '/admin/audit',
			target: navItem('/admin/audit'),
			title: 'Журнал',
			body: 'Все действия на платформе — без адресов, контактов и текстов.'
		},
		{
			href: '/admin/documents',
			target: navItem('/admin/documents'),
			title: 'Документы',
			body: 'Правовые документы и согласия по версиям: какая действует и какие заменены.'
		},
		{
			href: '/admin/staff',
			target: navItem('/admin/staff'),
			title: 'Персонал',
			body: 'Операторы ФСП и администраторы: найдите аккаунт и выдайте или снимите роль.'
		}
	],
	pages: [
		{
			route: '/admin',
			title: 'Модели и интеграции',
			steps: [
				{
					target: '[data-model-operation]',
					title: 'Операции моделей',
					body: 'Выключите операцию — продукт перейдёт в явный упрощённый режим, а не подменит результат.'
				},
				{
					target: testId('model-problems'),
					title: 'Вызовы без модели',
					body: 'Где модель не отработала: код ошибки и что обрабатывалось, без содержимого входа.'
				},
				{
					target: '#integrations-heading',
					title: 'Интеграции',
					body: 'Состояние базы, Redis и внешних сервисов: ФСП ID, разбора документов, песочницы, Telegram.'
				}
			]
		},
		{
			route: '/admin/taxonomy',
			title: 'Таксономия',
			steps: [
				{
					target: testId('taxonomy-versions'),
					title: 'Версии',
					body: 'Опубликованная версия неизменяема: новая приходит посевом при старте приложения.'
				},
				{
					target: testId('skills'),
					title: 'Навыки',
					body: 'Навыки выбранной версии вместе с синонимами.'
				},
				{
					target: testId('roles'),
					title: 'Роли',
					body: 'Роли выбранной версии справочника.'
				}
			]
		},
		{
			route: '/admin/rules',
			title: 'Правила',
			steps: [
				{
					target: '[data-ruleset]',
					title: 'Версии правил',
					body: 'Раскройте версию, чтобы увидеть пороги и веса категоризации и соответствия.'
				},
				{
					target: testId('projection-rules'),
					title: 'Проекция результатов ФСП',
					body: 'Какие навыки и роли подтверждает дисциплина соревнования и с каким весом.'
				}
			]
		},
		{
			route: '/admin/quality',
			title: 'Качество моделей',
			steps: [
				{
					target: '#run-heading',
					title: 'Последний прогон',
					body: 'Метрики с порогами и сравнение с базовым вариантом — только из записанных прогонов.'
				},
				{
					target: testId('eval-history'),
					title: 'История прогонов',
					body: 'Откройте прогон из истории, чтобы увидеть его цифры.'
				}
			]
		},
		{
			route: '/admin/quality/[id]',
			title: 'Прогон оценки',
			steps: [
				{
					target: testId('eval-split'),
					title: 'Выборка',
					body: 'На какой части размеченной выборки шёл прогон — рабочей или отложенной.'
				},
				{
					target: '#run-heading',
					title: 'Прогон',
					body: 'Метрики этого прогона с порогами и сравнением с базовым вариантом.'
				}
			]
		},
		{
			route: '/admin/policies',
			title: 'Политики продукта',
			steps: [
				{
					target: '[data-policy]',
					title: 'Политика',
					body: 'Параметры каждой версии с основанием; новую версию публикует посев при старте.'
				}
			]
		},
		{
			route: '/admin/bank',
			title: 'Банк заданий',
			steps: [
				{
					target: testId('bank-specialization'),
					title: 'Специализации',
					body: 'Специализация открыта кандидатам, когда она включена и у неё есть выпуск.'
				},
				{
					target: testId('bank-tree'),
					title: 'Семейства в банке',
					body: 'Каждое семейство проверено отдельно: видно дефекты и что ждёт независимой проверки.'
				},
				{
					target: testId('bank-release'),
					title: 'Выпуск',
					body: 'Кандидатам подаётся только выпуск, прошедший ворота семейств и симуляцию траекторий.'
				}
			]
		},
		{
			route: '/admin/audit',
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
		},
		{
			route: '/admin/documents',
			title: 'Документы',
			steps: [
				{
					target: testId('documents'),
					title: 'Правовые документы',
					body: 'Откройте документ, чтобы прочитать текст версии и её реквизиты.'
				}
			]
		},
		{
			route: '/admin/documents/[id]',
			title: 'Документ',
			steps: [
				{
					target: testId('document-body'),
					title: 'Текст',
					body: 'Текст версии ровно в том виде, в каком он опубликован.'
				}
			]
		},
		{
			route: '/admin/staff',
			title: 'Пользователи и персонал',
			steps: [
				{
					target: tourTarget('staff-search'),
					title: 'Найти пользователя',
					body: 'Введите почту целиком или идентификатор аккаунта.'
				},
				{
					target: '[data-user]',
					title: 'Аккаунт',
					body: 'Назначьте оператором ФСП или администратором — роль действует со следующего запроса.'
				},
				{
					target: testId('staff'),
					title: 'Персонал',
					body: 'Все роли персонала: здесь же снимается роль и право читать журнал.'
				}
			]
		}
	]
};
