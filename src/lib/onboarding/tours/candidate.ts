import { navItem, testId, TOUR_BUTTON, tourTarget, type WorkspaceTour } from '../types.js';

/**
 * Candidate cabinet: first where the person's data is kept and how to delete the account (the account page), then the
 * sections in the order of the navigation, then a tour for every page of the cabinet.
 */
export const candidateTour: WorkspaceTour = {
	workspace: 'candidate',
	welcome: {
		title: 'Здравствуйте!',
		body: 'Здесь работодатели сами приходят к вам с предложением и зарплатой. Покажем, где что, — это меньше минуты.'
	},
	main: [
		{
			href: null,
			target: TOUR_BUTTON,
			title: 'Подсказки — здесь',
			body: 'Этот туториал можно повторить здесь. А ещё у каждой страницы есть свой тур. Покажем, как пользоваться кабинетом.'
		},
		{
			href: '/account',
			target: testId('viewer-link'),
			title: 'Ваши данные — здесь',
			body: 'По вашему имени открывается учётная запись: вход, ФСП ID, сеансы и всё о ваших данных.'
		},
		{
			href: '/account',
			target: testId('account-data-export'),
			title: 'Мои данные',
			body: 'Всё, что платформа о вас собрала: посмотрите список и скачайте одним файлом.'
		},
		{
			href: '/account',
			target: testId('account-data-manage'),
			title: 'Управление данными',
			body: 'Здесь вы решаете, на что дано согласие и что видят работодатели.'
		},
		{
			href: '/account',
			target: testId('account-deletion'),
			title: 'Удалить учётную запись',
			body: 'Решите уйти — удаление здесь; до подтверждения видно, что сотрётся и что останется.'
		},
		{
			href: '/me/profile',
			target: navItem('/me/profile'),
			title: 'Профиль',
			body: 'Ваш проверенный профиль: достижения ФСП, навыки с доказательствами и PDF для работодателя.'
		},
		{
			href: '/me/category',
			target: navItem('/me/category'),
			title: 'Категория',
			body: 'Специализация и грейд, подтверждённые тестом, — по ним работодатели вас и находят.'
		},
		{
			href: '/me/resume',
			target: navItem('/me/resume'),
			title: 'Резюме',
			body: 'Загрузите резюме, и поля профиля заполнятся из него — вам останется только проверить.'
		},
		{
			href: '/me/vacancies',
			target: navItem('/me/vacancies'),
			title: 'Вакансии',
			body: 'Подходящие вакансии с процентом соответствия — на любую можно откликнуться.'
		},
		{
			href: '/me/invitations',
			target: navItem('/me/invitations'),
			title: 'Приглашения',
			body: 'Сюда компании присылают предложения с условиями и зарплатой — отвечаете вы.'
		},
		{
			href: '/me/challenges',
			target: navItem('/me/challenges'),
			title: 'Задания',
			body: 'Короткие задачи от компаний: решите и получите шанс на приглашение.'
		},
		{
			href: '/me/tests',
			target: navItem('/me/tests'),
			title: 'Тесты',
			body: 'Здесь вы подтверждаете грейд — без теста категория остаётся заявленной.'
		}
	],
	pages: [
		{
			route: '/me/profile',
			title: 'Профиль',
			steps: [
				{
					target: testId('search-status'),
					title: 'Готовность получать предложения',
					body: '«Активно ищу» и «Открыт к предложениям» показывают профиль компаниям, «Не ищу» скрывает. Согласие даётся один раз.'
				},
				{
					target: testId('profile-basics'),
					title: 'Основное',
					body: 'Заполните ФИО и желаемую должность, ниже — контакты: без них PDF-профиль не соберётся.'
				},
				{
					target: testId('fsp-achievements'),
					title: 'Достижения ФСП',
					body: 'Каждое достижение приходит с квитанцией проверки: видно, что именно подтверждено.'
				},
				{
					target: testId('skills'),
					title: 'Навыки',
					body: 'Смотрите, чем подтверждён навык: тест и ФСП весят больше заявленного.'
				}
			]
		},
		{
			route: '/me/category',
			title: 'Категория и грейд',
			steps: [
				{
					target: testId('step-to-category'),
					title: 'Шаг до категории',
					body: 'Видно, что уже сделано на пути к категории и что осталось.'
				},
				{
					target: testId('next-step'),
					title: 'Следующий шаг',
					body: 'Одна кнопка ведёт к следующему шагу: опросу, заявлению грейда или тесту.'
				},
				{
					target: testId('categories'),
					title: 'Действующие категории',
					body: 'По этим категориям работодатели собирают подборки, в которые вы попадаете.'
				},
				{
					target: testId('objections'),
					title: 'Возражения',
					body: 'Не согласны с итогом — подайте возражение, его рассмотрит оператор ФСП.'
				}
			]
		},
		{
			route: '/me/tests',
			title: 'Тест на грейд',
			steps: [
				{
					target: testId('grade-option'),
					title: 'Грейды',
					body: 'Выберите грейд и нажмите «Начать тест»; у закрытых указаны причина и дата.'
				},
				{
					target: testId('attempts'),
					title: 'Попытки',
					body: 'Все ваши попытки — отсюда открываются задания и результат.'
				}
			]
		},
		{
			route: '/me/tests/attempts/[attemptId]',
			title: 'Попытка',
			steps: [
				{
					target: testId('deadline'),
					title: 'Срок попытки',
					body: 'Следите за сроком: время попытки ограничено, к отвеченному вернуться нельзя.'
				},
				{
					target: testId('current-item'),
					title: 'Задание',
					body: 'Задания подаются по одному — сосредоточьтесь на текущем.'
				},
				{
					target: testId('answer-form'),
					title: 'Ответ',
					body: 'Ответьте и отправьте — следующее задание откроется сразу.'
				}
			]
		},
		{
			route: '/me/tests/decisions/[decisionId]',
			title: 'Результат теста',
			steps: [
				{
					target: testId('decision-reason'),
					title: 'Почему такой итог',
					body: 'Итог объяснён простыми словами, без одних только баллов.'
				},
				{
					target: testId('decision-blocks'),
					title: 'Блоки',
					body: 'Баллы по блокам показывают, где не хватило до порога.'
				},
				{
					target: testId('decision-next'),
					title: 'Что дальше',
					body: 'Здесь видно, когда можно пересдать или идти на грейд выше.'
				},
				{
					target: testId('decision-objection'),
					title: 'Возражение',
					body: 'Не согласны с решением — подайте возражение прямо отсюда.'
				}
			]
		},
		{
			route: '/me/confirmations',
			title: 'Запросы подтверждения',
			steps: [
				{
					target: testId('confirmation-requests'),
					title: 'Запросы компаний',
					body: 'Пройдите короткий блок-тест или откажитесь — отказ ни на что не влияет.'
				},
				{
					target: testId('block-results'),
					title: 'Результаты блок-тестов',
					body: 'Пройденный блок-тест — отдельное доказательство, которое видит компания.'
				}
			]
		},
		{
			route: '/me/resume',
			title: 'Резюме',
			steps: [
				{
					target: testId('resume-upload'),
					title: 'Загрузить резюме',
					body: 'Загрузите файл резюме, PDF, DOCX или даже скан, — поля из него разберутся сами.'
				},
				{
					target: testId('resume-claims'),
					title: 'Навыки и другие поля',
					body: 'Нажмите на цитату, чтобы увидеть её в тексте, и подтвердите или отклоните поле.'
				},
				{
					target: testId('model-mode'),
					title: 'Кто разбирал',
					body: 'Честная метка показывает, разобрала резюме модель или правила.'
				}
			]
		},
		{
			route: '/me/vacancies',
			title: 'Вакансии для вас',
			steps: [
				{
					target: testId('vacancy-search'),
					title: 'Поиск',
					body: 'Отфильтруйте вакансии по названию, роли, грейду и формату работы.'
				},
				{
					target: testId('vacancy-list'),
					title: 'Соответствие',
					body: 'Процент показывает, насколько вакансия вам подходит; «Вакансия и отклик» — подробности.'
				}
			]
		},
		{
			route: '/me/vacancies/[id]',
			title: 'Вакансия',
			steps: [
				{
					target: testId('application-form'),
					title: 'Откликнуться',
					body: 'Откликнитесь и выберите, что раскрыть компании, — остальное она не увидит.'
				},
				{
					target: testId('own-application'),
					title: 'Ваш отклик',
					body: 'Здесь виден статус вашего отклика на эту вакансию.'
				}
			]
		},
		{
			route: '/me/applications',
			title: 'Мои отклики',
			steps: [
				{
					target: testId('application-list'),
					title: 'Отклики',
					body: 'Статусы ваших откликов в одном месте; передумали — нажмите «Отозвать».'
				}
			]
		},
		{
			route: '/me/invitations',
			title: 'Приглашения',
			steps: [
				{
					target: testId('invitation-list'),
					title: 'Предложения компаний',
					body: 'Откройте приглашение, чтобы увидеть условия и ответить.'
				}
			]
		},
		{
			route: '/me/invitations/[id]',
			title: 'Приглашение',
			steps: [
				{
					target: testId('invitation-terms'),
					title: 'Условия',
					body: 'Условия и зарплата — сразу, до любого раскрытия контактов.'
				},
				{
					target: testId('why-you'),
					title: 'Почему вы',
					body: 'Компания объясняет, что увидела в вашем профиле.'
				},
				{
					target: testId('invitation-answer'),
					title: 'Принять или отклонить',
					body: 'Примите или отклоните — какие контакты получит компания, выбираете только вы.'
				},
				{
					target: testId('offer-complaint'),
					title: 'Жалоба на предложение',
					body: 'Что-то не так — пожалуйтесь оператору ФСП, компания не узнает, кто это сделал.'
				}
			]
		},
		{
			route: '/me/challenges',
			title: 'Задания компаний',
			steps: [
				{
					target: testId('challenge-list'),
					title: 'Задания',
					body: 'Задачи от компаний — откройте задание, чтобы его решить.'
				},
				{
					target: testId('advance-clock'),
					title: 'Промотать неделю',
					body: 'На демонстрационном стенде кнопка приводит новые задания, не дожидаясь недели.'
				}
			]
		},
		{
			route: '/me/challenges/[deliveryId]',
			title: 'Задание',
			steps: [
				{
					target: testId('challenge-statement'),
					title: 'Задача',
					body: 'Условие и цель задания — что именно ждёт компания.'
				},
				{
					target: tourTarget('challenge-solve'),
					title: 'Отправить решение',
					body: 'Отправьте решение — компания увидит его под псевдонимом, без вашего имени.'
				},
				{
					target: testId('own-solution'),
					title: 'Ваше решение',
					body: 'Решение принадлежит вам — отозвать его можно в любой момент.'
				}
			]
		},
		{
			route: '/me/visibility',
			title: 'Видимость и согласия',
			steps: [
				{
					target: testId('catalog-consent'),
					title: 'Показ в каталоге',
					body: 'Включите показ в каталоге — иначе работодатели вас не найдут.'
				},
				{
					target: testId('field-privacy'),
					title: 'Что видно работодателю',
					body: 'По каждому полю видно, что компания знает до контакта и что после.'
				},
				{
					target: testId('company-blocks'),
					title: 'Блок-лист компаний',
					body: 'Скройтесь от отдельных компаний — они не узнают, что попали в список.'
				}
			]
		},
		{
			route: '/me/settings',
			title: 'Предпочтения',
			steps: [
				{
					target: testId('settings-form'),
					title: 'Предпочтения',
					body: 'Укажите роли, формат и ожидания по зарплате — так подборки будут точнее.'
				}
			]
		},
		{
			route: '/me/consents',
			title: 'Согласия',
			steps: [
				{
					target: testId('processing-consent'),
					title: 'Обработка персональных данных',
					body: 'Здесь видно, на что вы дали согласие, и здесь же его можно отозвать.'
				},
				{
					target: testId('fsp-consent'),
					title: 'Достижения из систем ФСП',
					body: 'Согласие на импорт достижений ФСП управляется отдельно от остальных.'
				}
			]
		},
		{
			route: '/me/export',
			title: 'Мои данные',
			steps: [
				{
					target: testId('data-export'),
					title: 'Что в выгрузке',
					body: 'Список показывает, что именно платформа хранит о вас.'
				},
				{
					target: testId('data-export-download'),
					title: 'Скачать мои данные',
					body: 'Скачайте всё о себе одним файлом JSON.'
				}
			]
		},
		{
			route: '/account',
			title: 'Учётная запись',
			steps: [
				{
					target: testId('account-data'),
					title: 'Мои данные',
					body: 'Скачайте всё, что платформа о вас хранит, и настройте согласия и видимость.'
				},
				{
					target: testId('fsp-section'),
					title: 'ФСП ID',
					body: 'Привяжите ФСП ID — достижения соревнований подтянутся в профиль сами.'
				},
				{
					target: testId('session-count'),
					title: 'Сеансы',
					body: 'Видите лишние сеансы — завершите их кнопкой «Выйти на всех устройствах».'
				},
				{
					target: testId('account-deletion'),
					title: 'Удаление учётной записи',
					body: 'Удалить учётную запись можно здесь — сначала покажем, что сотрётся и что останется.'
				}
			]
		},
		{
			route: '/account/notifications',
			title: 'Уведомления',
			steps: [
				{
					target: testId('channel-settings'),
					title: 'Каналы по темам',
					body: 'Выберите, о чём и куда присылать уведомления: почта или Telegram.'
				},
				{
					target: testId('telegram'),
					title: 'Telegram',
					body: 'Привяжите Telegram, чтобы не пропустить новое приглашение.'
				}
			]
		},
		{
			route: '/account/delete',
			title: 'Удаление учётной записи',
			steps: [
				{
					target: testId('deletion-effects'),
					title: 'Что произойдёт',
					body: 'Сначала посмотрите, что сотрётся сразу и что — в течение 30 дней.'
				},
				{
					target: testId('deletion-kept'),
					title: 'Что останется',
					body: 'Здесь честно перечислено, что останется после удаления и почему.'
				},
				{
					target: testId('deletion-confirm'),
					title: 'Подтверждение',
					body: 'Удаление вступает в силу только после вашего подтверждения здесь.'
				}
			]
		},
		{
			route: '/notifications',
			title: 'Уведомления',
			steps: [
				{
					target: testId('notification-list'),
					title: 'Уведомления',
					body: 'Все уведомления в одном месте — непрочитанные выделены.'
				}
			]
		},
		{
			route: '/notifications/[id]',
			title: 'Уведомление',
			steps: [
				{
					target: tourTarget('notification-back'),
					title: 'Ко всем уведомлениям',
					body: 'То, о чём было уведомление, больше недоступно — вернитесь к остальным.'
				}
			]
		}
	]
};
