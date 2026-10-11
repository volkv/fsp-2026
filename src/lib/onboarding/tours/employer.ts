import { navItem, testId, TOUR_BUTTON, tourTarget, type WorkspaceTour } from '../types.js';

/** Employer cabinet: the sections in the order of the navigation, then a tour for every page of the cabinet. */
export const employerTour: WorkspaceTour = {
	workspace: 'employer',
	welcome: {
		title: 'Здравствуйте!',
		body: 'Здесь вы сами находите проверенных ИТ-специалистов и первыми предлагаете им работу. Покажем, где что, — меньше минуты.'
	},
	main: [
		{
			href: null,
			target: TOUR_BUTTON,
			title: 'Подсказки — здесь',
			body: 'Этот туториал можно повторить здесь. А ещё у каждой страницы есть свой тур. Покажем, как пользоваться кабинетом.'
		},
		{
			href: '/company/needs',
			target: navItem('/company/needs'),
			title: 'Потребности',
			body: 'Опишите своими словами, кого ищете, — и соберите подборку проверенных кандидатов.'
		},
		{
			href: '/company/candidates',
			target: navItem('/company/candidates'),
			title: 'Кандидаты',
			body: 'Каталог проверяемых профилей с фильтрами по специализации, грейду, стеку и уровню ФСП.'
		},
		{
			href: '/company/vacancies',
			target: navItem('/company/vacancies'),
			title: 'Вакансии',
			body: 'Вставьте текст вакансии — черновик соберётся сам, а кандидаты откликнутся на опубликованную.'
		},
		{
			href: '/company/invitations',
			target: navItem('/company/invitations'),
			title: 'Приглашения',
			body: 'Ваши предложения работы: статус, текущие условия и срок ответа кандидата.'
		},
		{
			href: '/company/applications',
			target: navItem('/company/applications'),
			title: 'Отклики',
			body: 'Входящие отклики на ваши вакансии — с процентом соответствия по каждому кандидату.'
		},
		{
			href: '/company/challenges',
			target: navItem('/company/challenges'),
			title: 'Задания',
			body: 'Короткие задачи от компании: по решениям вы находите сильных и приглашаете их.'
		},
		{
			href: '/company/hiring',
			target: navItem('/company/hiring'),
			title: 'Найм',
			body: 'Этапы и исходы найма по всем кандидатам, принявшим ваше приглашение.'
		},
		{
			href: '/company/partner-pools',
			target: navItem('/company/partner-pools'),
			title: 'Пул партнёра',
			body: 'Финалисты соревнований ФСП, где компания — партнёр, согласные на контакт.',
			permission: 'partner_pool.read'
		},
		{
			href: '/company/profile',
			target: navItem('/company/profile'),
			title: 'Компания',
			body: 'Профиль, который видят кандидаты, проверка оператором ФСП и ваша команда.'
		}
	],
	pages: [
		{
			route: '/company/needs',
			title: 'Потребности',
			steps: [
				{
					target: testId('need-create'),
					title: 'Опишите, кого ищете',
					body: 'Напишите задачу своими словами и нажмите «Разобрать и сохранить» — поля заполнятся сами.'
				},
				{
					target: testId('need-list'),
					title: 'Потребности компании',
					body: 'Откройте потребность, чтобы проверить разбор и собрать подборку кандидатов.'
				}
			]
		},
		{
			route: '/company/needs/[id]',
			title: 'Потребность',
			steps: [
				{
					target: testId('need-form'),
					title: 'Форма потребности',
					body: 'Проверьте разобранные поля и нажмите «Подтвердить» — у каждого значения есть цитата из текста.'
				},
				{
					target: testId('need-categories'),
					title: 'Рекомендованные категории',
					body: 'Сколько кандидатов с подтверждённой категорией вам видно и сколько из них с результатами ФСП.'
				},
				{
					target: testId('shortlist-create'),
					title: 'Подборка кандидатов',
					body: 'Отметьте категории и нажмите «Собрать подборку» — кандидаты встанут по соответствию.'
				}
			]
		},
		{
			route: '/company/shortlists/[id]',
			title: 'Подборка',
			steps: [
				{
					target: testId('shortlist-reasons'),
					title: 'Почему подходит',
					body: 'У каждого довода в пользу кандидата есть источник — видно, что подтверждено.'
				},
				{
					target: testId('shortlist-offer'),
					title: 'Предложить работу',
					body: 'Напишите кандидату первыми — пункты «почему вы» подставятся из подборки.'
				},
				{
					target: testId('shortlist-what-if'),
					title: 'Что если',
					body: 'Поменяйте одно условие или вилку и увидите, кто станет доступен, а кто выпадет.'
				},
				{
					target: testId('shortlist-revise'),
					title: 'Уточнить',
					body: 'Добавьте требования новым шагом — подборка и отметки сохранятся.'
				}
			]
		},
		{
			route: '/company/shortlists/[id]/evaluate',
			title: 'Оценка подбора',
			steps: [
				{
					target: tourTarget('evaluate-start'),
					title: 'Слепое сравнение',
					body: 'Сравните первую десятку подборки с поиском по ключевым словам, не зная, кто какую выбрал.'
				},
				{
					target: testId('evaluation-cards'),
					title: 'Отметьте подходящих',
					body: 'Отметьте тех, кто подходит, и нажмите «Сохранить оценку».'
				},
				{
					target: testId('evaluation-result'),
					title: 'Результат оценки',
					body: 'Точность первой десятки подборки и поиска по словам — на ваших собственных отметках.'
				}
			]
		},
		{
			route: '/company/candidates',
			title: 'Кандидаты',
			steps: [
				{
					target: tourTarget('candidates-filters'),
					title: 'Фильтры',
					body: 'Задайте специализацию, грейд, стек и уровень ФСП — каталог сузится до нужных.'
				},
				{
					target: tourTarget('candidates-list'),
					title: 'Кандидаты',
					body: 'Откройте карточку — имени и контактов в ней нет до согласия кандидата.'
				}
			]
		},
		{
			route: '/company/candidates/[pseudonym]',
			title: 'Кандидат',
			steps: [
				{
					target: tourTarget('candidate-confirmed'),
					title: 'Что подтверждено',
					body: 'Каждый навык — с уровнем доверия к источнику: тест и ФСП весят больше заявленного.'
				},
				{
					target: tourTarget('candidate-fsp'),
					title: 'Достижения ФСП',
					body: 'Результаты соревнований ФСП с квитанцией проверки — видно, что именно подтверждено.'
				},
				{
					target: tourTarget('candidate-offer'),
					title: 'Предложить работу',
					body: 'Отправьте предложение: описание, вилка в рублях, способ связи и «почему вы».'
				},
				{
					target: testId('confirmation-request'),
					title: 'Запросить подтверждение',
					body: 'Нужен навык вне категории кандидата — попросите его пройти короткий блок-тест.'
				}
			]
		},
		{
			route: '/company/vacancies',
			title: 'Вакансии',
			steps: [
				{
					target: tourTarget('vacancies-new'),
					title: 'Новая вакансия',
					body: 'Вставьте текст вакансии как есть — черновик соберётся за секунды.'
				},
				{
					target: tourTarget('vacancies-list'),
					title: 'Вакансии компании',
					body: 'Статус, вилка и размер пула по каждой вакансии — и переход к кандидатам под неё.'
				}
			]
		},
		{
			route: '/company/vacancies/new',
			title: 'Новая вакансия',
			steps: [
				{
					target: tourTarget('vacancy-text'),
					title: 'Вставить текст',
					body: 'Вставьте текст вакансии и нажмите «Разобрать» — роль, грейд, навыки и вилка найдутся сами.'
				},
				{
					target: testId('draft'),
					title: 'Черновик из текста',
					body: 'Проверьте черновик: у каждого значения — цитата, а недостающие поля выделены.'
				},
				{
					target: testId('pool-estimate'),
					title: 'Пул кандидатов',
					body: 'Сколько подтверждённых кандидатов подходит ещё до сохранения вакансии.'
				}
			]
		},
		{
			route: '/company/vacancies/[id]',
			title: 'Вакансия',
			steps: [
				{
					target: tourTarget('vacancy-publish'),
					title: 'Публикация',
					body: 'Нажмите «Опубликовать» — спорные формулировки проверка текста подсветит заранее.'
				},
				{
					target: testId('vacancy-test-spec'),
					title: 'Тест вакансии',
					body: 'Каким будет тест: что по требованиям вакансии проверим у кандидатов.'
				},
				{
					target: tourTarget('vacancy-candidates-link'),
					title: 'Кандидаты под вакансию',
					body: 'Кандидаты с разбором соответствия именно этой вакансии.'
				}
			]
		},
		{
			route: '/company/vacancies/[id]/candidates',
			title: 'Кандидаты под вакансию',
			steps: [
				{
					target: tourTarget('vacancy-candidates-list'),
					title: 'Кандидаты',
					body: 'Подтверждённые кандидаты идут первыми — с процентом соответствия и покрытием требований.'
				},
				{
					target: tourTarget('vacancy-compare'),
					title: 'Сравнить отмеченных',
					body: 'Отметьте нескольких кандидатов и нажмите «Сравнить отмеченных».'
				},
				{
					target: testId('comparison'),
					title: 'Сравнение',
					body: 'Отмеченные кандидаты бок о бок по каждому требованию вакансии.'
				}
			]
		},
		{
			route: '/company/vacancies/[id]/candidates/[pseudonym]',
			title: 'Кандидат под вакансию',
			steps: [
				{
					target: tourTarget('vacancy-match'),
					title: 'Соответствие',
					body: 'Из чего складывается соответствие кандидата этой вакансии — по каждому компоненту.'
				},
				{
					target: tourTarget('candidate-confirmed'),
					title: 'Что подтверждено',
					body: 'Каждый навык — с уровнем доверия к источнику: тест и ФСП весят больше заявленного.'
				},
				{
					target: tourTarget('vacancy-offer'),
					title: 'Предложить работу',
					body: 'Условия вакансии уже подставлены — проверьте их и отправьте предложение.'
				}
			]
		},
		{
			route: '/company/invitations',
			title: 'Приглашения',
			steps: [
				{
					target: tourTarget('invitations-list'),
					title: 'Приглашения',
					body: 'Статус и срок ответа по каждому предложению — откройте, чтобы увидеть ответ кандидата.'
				}
			]
		},
		{
			route: '/company/invitations/[id]',
			title: 'Приглашение',
			steps: [
				{
					target: testId('current-terms'),
					title: 'Текущие условия',
					body: 'Отправленные условия не меняются — «Пересмотреть условия» создаст новую версию.'
				},
				{
					target: testId('contacts'),
					title: 'Контакты кандидата',
					body: 'Контакты появятся здесь, когда кандидат примет предложение.'
				},
				{
					target: testId('hiring'),
					title: 'Процесс найма',
					body: 'Отмечайте этапы и исход найма — кандидат отмечает свои, расхождения видны обоим.'
				}
			]
		},
		{
			route: '/company/applications',
			title: 'Отклики',
			steps: [
				{
					target: testId('incoming-applications'),
					title: 'Входящие отклики',
					body: 'Откройте отклик, чтобы увидеть соответствие кандидата и ответить ему.'
				}
			]
		},
		{
			route: '/company/applications/[id]',
			title: 'Отклик',
			steps: [
				{
					target: testId('application-match'),
					title: 'Соответствие',
					body: 'Соответствие на момент отклика — по каждому компоненту отдельно.'
				},
				{
					target: testId('application-contacts'),
					title: 'Контакты по отклику',
					body: 'Контакты, которые кандидат сам открыл вашей компании вместе с откликом.'
				},
				{
					target: testId('application-offer'),
					title: 'Пригласить по отклику',
					body: 'Отправьте предложение с вилкой и «почему вы» — или откажите кандидату.'
				}
			]
		},
		{
			route: '/company/challenges',
			title: 'Задания',
			steps: [
				{
					target: testId('challenge-create'),
					title: 'Новое задание',
					body: 'Опишите задачу, специализацию и вилку и нажмите «Сохранить задание».'
				},
				{
					target: testId('challenge-list'),
					title: 'Задания компании',
					body: 'Откройте задание, чтобы опубликовать его и смотреть решения.'
				}
			]
		},
		{
			route: '/company/challenges/[id]',
			title: 'Задание',
			steps: [
				{
					target: testId('challenge-counts'),
					title: 'Отклик на задание',
					body: 'Сколько кандидатов получили задание, открыли его и прислали решения.'
				},
				{
					target: testId('challenge-solutions'),
					title: 'Решения',
					body: 'Решения под псевдонимами — «Пригласить по решению» ведёт сразу к предложению.'
				}
			]
		},
		{
			route: '/company/hiring',
			title: 'Найм',
			steps: [
				{
					target: tourTarget('hiring-list'),
					title: 'Процессы найма',
					body: 'Все кандидаты, принявшие приглашение, — с этапами и сроком исхода.'
				}
			]
		},
		{
			route: '/company/confirmations',
			title: 'Запросы подтверждения',
			steps: [
				{
					target: testId('company-confirmations'),
					title: 'Запросы подтверждения',
					body: 'Ваши запросы кандидатам и результаты блок-тестов по ним.'
				}
			]
		},
		{
			route: '/company/partner-pools',
			title: 'Пулы партнёра',
			steps: [
				{
					target: tourTarget('pools-list'),
					title: 'Партнёрства',
					body: 'Соревнования ФСП, где компания — партнёр: пока партнёрство действует, пул открыт.'
				}
			]
		},
		{
			route: '/company/partner-pools/[partnershipId]',
			title: 'Пул партнёра',
			steps: [
				{
					target: testId('pool-partnership'),
					title: 'Правило пула',
					body: 'Кто попадает в пул этого соревнования и сколько действует партнёрство.'
				},
				{
					target: testId('pool-members'),
					title: 'Финалисты',
					body: 'Финалисты, согласные на контакт с партнёрами, — с точным результатом соревнования.'
				},
				{
					target: testId('pool-invite'),
					title: 'Предложить работу',
					body: 'Предложите работу финалисту с вакансией или без неё.'
				}
			]
		},
		{
			route: '/company/profile',
			title: 'Компания',
			steps: [
				{
					target: testId('company-public-profile'),
					title: 'Профиль для кандидатов',
					body: 'Заполните описание и направление деятельности — без них предложение не отправить.'
				},
				{
					target: tourTarget('profile-verification'),
					title: 'Проверка оператором ФСП',
					body: 'Подайте на проверку — в предложениях появится метка «проверена».'
				}
			]
		},
		{
			route: '/company/profile/team',
			title: 'Команда',
			steps: [
				{
					target: tourTarget('team-invite'),
					title: 'Пригласить в команду',
					body: 'Пригласите рекрутеров по рабочей почте — они будут вести вакансии и подбор.'
				}
			]
		},
		{
			route: '/company/profile/keys',
			title: 'Ключи API',
			steps: [
				{
					target: tourTarget('keys-create'),
					title: 'Новый ключ',
					body: 'Выпустите ключ, чтобы ваша система работала с платформой через API.'
				}
			]
		},
		{
			route: '/company/profile/integrations',
			title: 'События для ATS',
			steps: [
				{
					target: tourTarget('ats-webhook'),
					title: 'Новый вебхук',
					body: 'Укажите адрес вашей системы — отклики, ответы на предложения и этапы найма придут туда сами.'
				},
				{
					target: tourTarget('ats-huntflow'),
					title: 'Хантфлоу',
					body: 'Подключите Хантфлоу — принявший предложение кандидат появится на вашей вакансии там сам.'
				},
				{
					target: tourTarget('ats-subscriptions'),
					title: 'Подписки',
					body: 'Ваши подписки и журнал доставок: что ушло, что повторяется и почему.'
				}
			]
		}
	]
};
