import { describe, expect, it } from 'vitest';
import { CONTACT_MASK, candidateTextForCompany, maskContacts } from './contact-mask';

const M = CONTACT_MASK;

describe('maskContacts', () => {
	it.each([
		['Пишите: ivan.petrov+jobs@mail.ru', `Пишите: ${M}`],
		['почта: IVAN@Yandex.RU.', `почта: ${M}.`],
		['адрес иван@почта.рф', `адрес ${M}`],
		['+7 (912) 345-67-89', M],
		['+79123456789', M],
		['тел. 8 (912) 345-67-89, звоните', `тел. ${M}, звоните`],
		['89123456789', M],
		['8-912-345-67-89', M],
		['8 912 345 67 89', M],
		['(912) 345-67-89', M],
		['912-345-67-89', M],
		['London +44 20 7946 0958', `London ${M}`],
		['+1-202-555-0143', M],
		['https://t.me/ivan_dev', M],
		['t.me/ivan_dev', M],
		['wa.me/79123456789', M],
		['vk.com/id12345', M],
		['https://vk.com/ivan.', `${M}.`],
		['m.vk.com/ivan', M],
		['tg://resolve?domain=ivan', M],
		['skype:ivan.petrov', M],
		['mailto:ivan@mail.ru', M],
		['мой сайт https://ivanov.dev/cv, там всё', `мой сайт ${M}, там всё`],
		['www.ivanov.dev', M],
		['сайт ivanov.ru', `сайт ${M}`],
		['(см. github.com/ivan/solution)', `(см. ${M})`],
		['https://github.com/ivan', M],
		['https://codeforces.com/profile/ivan', M],
		['git@github.com:ivan/repo.git', M],
		['телеграм @ivan_dev, пишите', `телеграм ${M}, пишите`],
		['Связь — @IvanDev.', `Связь — ${M}.`]
	])('masks %s', (input, expected) => {
		expect(maskContacts(input)).toBe(expected);
	});

	it.each([
		'Знаю C++17 и C++20, Python 3.12.1, Node v24.1.0',
		'Работал с 2019-03-01 по 2023-12-31, 10^9+7 и 1e9+7 по модулю',
		'IP 192.168.0.1, порт 57432, ответ 1000000007',
		'@Override\npublic String toString() {}',
		'    @property\n    def name(self):',
		'/**\n * @param value число\n * @returns сумму\n */',
		'@media (max-width: 600px) {}',
		'C = A @ B  # matmul\nD = A@B',
		'@app.route("/")\n@pytest.fixture',
		'self.net = Net()\nlog.info("x")\nos.path.join(a, b)',
		'obj.com(1); std::vector<int> v; x.size()',
		'user@example.com, test@mail.test',
		'см. https://en.cppreference.com/w/cpp/container/vector и cp-algorithms.com/graph/dfs.html',
		'+7 лет опыта, рейтинг +1500',
		'@all @dev',
		'n = 100000\nfor i in range(8, 912345):'
	])('keeps technical text: %s', (input) => {
		expect(maskContacts(input)).toBe(input);
	});

	it('masks every contact of a mixed text and keeps the rest', () => {
		const text = 'Решение на C++17. Вопросы — ivan@mail.ru или @ivan_dev, тел. +7 912 345-67-89.';
		expect(maskContacts(text)).toBe(`Решение на C++17. Вопросы — ${M} или ${M}, тел. ${M}.`);
	});
});

describe('candidateTextForCompany', () => {
	it('masks before the disclosure and shows the text as written after it', () => {
		expect(candidateTextForCompany('мой @ivan_dev', false)).toBe(`мой ${M}`);
		expect(candidateTextForCompany('мой @ivan_dev', true)).toBe('мой @ivan_dev');
	});
});
