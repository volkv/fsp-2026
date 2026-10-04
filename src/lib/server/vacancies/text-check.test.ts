import { describe, expect, it } from 'vitest';
import { checkVacancyText, sameBlockingFindings, sameFindings, TEXT_CHECK_VERSION } from './text-check';

const rulesOf = (text: string) => checkVacancyText({ description: text }).phrases.map((p) => p.rule);

describe('discriminatory requirements', () => {
	it.each([
		['Ищем разработчика, только мужчина', 'sex.explicit'],
		['Ищем мужчину на позицию DevOps', 'sex.explicit'],
		['Ищем девушку в отдел тестирования', 'sex.explicit'],
		['Ищем женщину-аналитика', 'sex.explicit'],
		['Нужен парень на поддержку', 'sex.explicit'],
		['Рассмотрим юношей после колледжа', 'sex.explicit'],
		['Ищем опытного Python-разработчика мужчину', 'sex.explicit'],
		['Вакансия только для девушек', 'sex.explicit'],
		['Мужчина, любой опыт', 'sex.explicit'],
		['Требования: мужчина, опыт от 3 лет', 'sex.explicit'],
		['Требования:\n• Девушка до 30 лет', 'sex.explicit'],
		['Пол: мужской', 'sex.explicit'],
		['Кандидат женского пола', 'sex.explicit'],
		['Возраст до 35 лет', 'age.limit'],
		['Возраст: 25–35', 'age.limit'],
		['Ищем специалиста в возрасте от 20 до 30', 'age.limit'],
		['Возраст до 35 лет, опыт от 3 лет', 'age.limit'],
		['Опыт от 3 лет, возраст 25–35 лет', 'age.limit'],
		['Опыт от 3 лет, до 35 лет', 'age.limit'],
		['Кандидат не старше 40 лет', 'age.limit'],
		['Возраст не старше 45', 'age.limit'],
		['Кандидаты 1990 г.р. и моложе', 'age.limit'],
		['Гражданство РФ обязательно', 'citizenship.required'],
		['Российское гражданство обязательно', 'citizenship.required'],
		['Желательно женат, без детей', 'marital.status'],
		['Замужняя, не планирующая декрет', 'marital.status'],
		['Женат, любой опыт', 'marital.status'],
		['Славянская внешность', 'nationality.explicit'],
		['Европейская внешность', 'nationality.explicit'],
		['Национальность: русский', 'nationality.explicit'],
		['Требования: мужской пол', 'sex.explicit'],
		['Кандидат пола мужского', 'sex.explicit'],
		['Женщин не рассматриваем', 'sex.explicit'],
		['Мужчины не рассматриваются', 'sex.explicit'],
		['Вакансия для мужчин', 'sex.explicit'],
		['Работа для девушек, график 5/2', 'sex.explicit'],
		['Кандидат не старше тридцати лет', 'age.limit'],
		['Не старше сорока', 'age.limit'],
		['До тридцати пяти лет', 'age.limit'],
		['Возрастной ценз: до 35', 'age.limit'],
		['35+ не рассматриваем', 'age.limit'],
		['Кандидатов старше 45 не берём', 'age.limit'],
		['После 40 не рассматриваем', 'age.limit'],
		['Возраст: 35+', 'age.limit'],
		['Кандидаты до 35-ти лет', 'age.limit'],
		['Работа для студентов до 25', 'age.limit'],
		['Возрастные ограничения: 20-30', 'age.limit'],
		['Молодой специалист до 30', 'age.limit'],
		['Выпускники до 23.', 'age.limit'],
		['не старше тридцати лет', 'age.limit'],
		['не старше сорока', 'age.limit'],
		['до 35-ти лет', 'age.limit'],
		['пол мужской', 'sex.explicit'],
		['Только мужчины', 'sex.explicit'],
		['не старше 30 лет', 'age.limit'],
		['Ищем девушку', 'sex.explicit']
	])('blocks «%s»', (text, rule) => {
		const check = checkVacancyText({ description: text });
		expect(check.result).toBe('blocked');
		expect(check.phrases.map((p) => p.rule)).toContain(rule);
		expect(check.phrases[0]?.explanation).toMatch(/.{20,}/);
	});

	it('finds the age and the sex in one clause', () => {
		expect(rulesOf('Только мужчины до 30 лет').sort()).toEqual(['age.limit', 'sex.explicit']);
	});

	it('takes the whole age phrase', () => {
		const check = checkVacancyText({ description: 'Ищем специалиста в возрасте от 20 до 30, опыт от года' });
		expect(check.phrases.map((p) => p.text)).toEqual(['в возрасте от 20 до 30']);
	});

	it.each([
		['Только граждане РФ', 'citizenship.required', 'Только граждане РФ'],
		['Гражданин России', 'citizenship.required', 'Гражданин России'],
		['Вакансия открыта гражданам Российской Федерации', 'citizenship.required', 'гражданам Российской Федерации'],
		['Обязательно наличие гражданства', 'citizenship.required', 'наличие гражданства'],
		['Желательно замужем', 'marital.status', 'замужем'],
		['Холостой, готов к командировкам', 'marital.status', 'Холостой'],
		['Незамужняя кандидатка', 'marital.status', 'Незамужняя'],
		['Отсутствие детей обязательно', 'marital.status', 'Отсутствие детей'],
		['Только славяне', 'nationality.explicit', 'славяне'],
		['Кандидат славянского происхождения', 'nationality.explicit', 'славянского происхождения'],
		['Русский по национальности', 'nationality.explicit', 'Русский по национальности'],
		['Презентабельная внешность', 'appearance.explicit', 'Презентабельная внешность'],
		['Хорошие внешние данные', 'appearance.explicit', 'внешние данные'],
		['Рост от 170 см', 'appearance.explicit', 'Рост от 170'],
		['Пришлите фото и резюме', 'appearance.explicit', 'Пришлите фото'],
		['Приложите своё фото к отклику', 'appearance.explicit', 'Приложите своё фото']
	])('finds «%s»', (text, rule, phrase) => {
		const check = checkVacancyText({ description: text });
		expect(check.phrases.map((p) => [p.rule, p.text])).toContainEqual([rule, phrase]);
	});

	it.each([
		['Ищем молодого специалиста', 'age.youth'],
		['Программа для молодых специалистов', 'age.youth'],
		['Ищем сотрудницу', 'sex.gendered_title'],
		['Ищем сотрудницу в отдел продаж', 'sex.gendered_title'],
		['Требуется бухгалтерша', 'sex.gendered_title'],
		['Ищем опытную администраторшу', 'sex.gendered_title']
	])('warns about «%s»', (text, rule) => {
		const check = checkVacancyText({ description: text });
		expect(check).toMatchObject({ result: 'warnings', phrases: [{ rule, severity: 'warning' }] });
	});

	it('warns about phrasings that often hide an age preference', () => {
		const check = checkVacancyText({ description: 'У нас молодой дружный коллектив' });
		expect(check).toMatchObject({ result: 'warnings', phrases: [{ rule: 'age.youth', severity: 'warning' }] });
	});

	it('warns about requirements to appearance', () => {
		expect(rulesOf('Резюме с фото присылайте на почту')).toEqual(['appearance.explicit']);
		expect(rulesOf('Приятная внешность')).toEqual(['appearance.explicit']);
	});

	it.each([
		'Опыт работы от 3 до 5 лет',
		'Опыт от 3 лет',
		'Опыт работы с Python от 10 до 15 лет',
		'От 10 до 15 лет опыта в разработке',
		'Компания на рынке 15–20 лет',
		'Возраст и пол не важны',
		'Опыт коммерческой разработки от 2 лет, Python, PostgreSQL',
		'Работа в команде из 10 человек',
		'Команда из мужчин и женщин, средний опыт — 6 лет',
		'Рассматриваем и мужчин, и женщин',
		'Приглашаем девушек и юношей на стажировку',
		'Кандидаты мужского или женского пола',
		'Пол: мужской или женский',
		'Возрастная группа: мужчины, женщины',
		'Женский коллектив дружелюбный, поможем освоиться',
		'Наш партнёр — мужская сборная ФСП по спортивному программированию',
		'Нужны юнит-тесты для мужского и женского каталогов товаров',
		'Разрабатываем приложение для женщин, следящих за здоровьем',
		'Девушки составляют 40% команды',
		'Ищем специалистов по работе с женщинами-предпринимателями',
		'Нужен сервис для женщин-предпринимателей',
		'Парное программирование и код-ревью',
		'Рассматриваем кандидатов независимо от национальности',
		'Национальность и гражданство значения не имеют',
		'Семейное положение не важно',
		'Гражданство РФ не обязательно, возможна удалённая работа',
		'Оформление по ТК РФ, ДМС для сотрудников с детьми',
		'Опыт от 3 лет, Python 3.10+',
		'Версия 3.5+ и выше',
		'Java 17+, Spring Boot 3',
		'Поддерживаем Node 18+ и PostgreSQL 14+',
		'Зарплата до 35 000 ₽',
		'Специалист до 35 000 ₽ на руки',
		'Стипендия студентам до 25 тыс. в месяц',
		'Команда до 30 человек',
		'Контракт до 27 года с продлением',
		'Сдать проект специалисту до 30 числа',
		'Старше 10 лет на рынке, более 200 клиентов',
		'Опыт от 5 лет не рассматриваем как обязательный',
		'Кандидатов с опытом меньше 10 лет не рассматриваем',
		'Наша сотрудница расскажет о команде',
		'Ищем сотрудника или сотрудницу в отдел продаж',
		'Ищем бухгалтера/бухгалтершу',
		'Ищем сотрудницу или сотрудника',
		'Ищем сотрудницу (сотрудника) в отдел продаж',
		'Java 11 не рассматриваем, только 17+',
		'Сотрудницы и сотрудники получают ДМС',
		'Приложение для мужчин и женщин',
		'Работаем с женщинами-предпринимателями',
		'Рост выручки от 150% в год',
		'Возрастной ценз отсутствует',
		'Молодёжные проекты и хакатоны для студентов'
	])('passes «%s»', (text) => {
		expect(checkVacancyText({ description: text })).toMatchObject({ result: 'clean', phrases: [] });
	});

	it('locates the phrase in code points of its field', () => {
		const check = checkVacancyText({ title: 'Разработчик 🚀', description: '🚀 Только мужчины' });
		const [phrase] = check.phrases;
		expect(phrase).toMatchObject({ field: 'description', start: 2, end: 16, text: 'Только мужчины' });
	});

	it('treats the same findings after an edit as the same', () => {
		const a = checkVacancyText({ description: 'Молодой коллектив. Python.' });
		const b = checkVacancyText({ description: 'Python, Go. Молодой коллектив.' });
		expect(sameFindings(a, b)).toBe(true);
		expect(sameFindings(a, checkVacancyText({ description: 'Приятная внешность' }))).toBe(false);
	});

	it('does not carry a verdict over from another version of the rules', () => {
		const current = checkVacancyText({ description: 'Гражданство РФ обязательно' });
		expect(current.validator_version).toBe(TEXT_CHECK_VERSION);
		const earlier = { ...current, validator_version: 'text-check/2' };
		expect(sameBlockingFindings(current, current)).toBe(true);
		expect(sameBlockingFindings(earlier, current)).toBe(false);
	});
});
