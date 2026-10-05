import { describe, expect, it } from 'vitest';
import {
	normalizedFullName,
	normalizeEmail,
	normalizeNameText,
	normalizePhone,
	normalizeTelegram,
	parseFullName
} from './contacts';
import { softSkillOf, softSkillsIn } from './soft-skills';

describe('full name', () => {
	it('reads the order of a Russian name from the patronymic and the surname', () => {
		expect(parseFullName('Иванова Мария Сергеевна')).toEqual({ last: 'Иванова', first: 'Мария', middle: 'Сергеевна' });
		expect(parseFullName('Мария Сергеевна Иванова')).toEqual({ last: 'Иванова', first: 'Мария', middle: 'Сергеевна' });
		expect(parseFullName('Иван Петров')).toEqual({ last: 'Петров', first: 'Иван', middle: null });
		expect(parseFullName('ТУМАНОВА МАРИЯ')).toEqual({ last: 'Туманова', first: 'Мария', middle: null });
		expect(parseFullName('Ivan Petrov')).toEqual({ first: 'Ivan', last: 'Petrov', middle: null });
		expect(parseFullName('Анна-Мария Римская-Корсакова')).toEqual({
			first: 'Анна-Мария',
			last: 'Римская-Корсакова',
			middle: null
		});
	});

	it('refuses what is not two or three words of letters', () => {
		expect(parseFullName('Backend-разработчик 2024')).toBeNull();
		expect(parseFullName('Мария')).toBeNull();
		expect(parseFullName('ООО Ромашка Плюс Один')).toBeNull();
	});

	it('normalizes the name for the holder commitment the same way as a typed name', () => {
		const name = { last: 'Ёлкина', first: 'Мария', middle: 'Сергеевна' };
		expect(normalizedFullName(name)).toBe('елкина мария сергеевна');
		expect(normalizeNameText('  ЕЛКИНА   мария Сергеевна ')).toBe(normalizedFullName(name));
	});
});

describe('contacts', () => {
	it('writes a Russian phone in any common spelling as +7 and an international one as written digits', () => {
		for (const written of ['+7 (912) 345-67-89', '8 912 345 67 89', '89123456789', '9123456789']) {
			expect(normalizePhone(written), written).toBe('+79123456789');
		}
		expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
		expect(normalizePhone('12-34')).toBeNull();
		expect(normalizePhone('позвоните мне')).toBeNull();
	});

	it('reads an address and a Telegram name, and nothing else', () => {
		expect(normalizeEmail(' Maria.Ivanova@Mail.RU ')).toBe('maria.ivanova@mail.ru');
		expect(normalizeEmail('maria@')).toBeNull();
		expect(normalizeTelegram('@maria_dev')).toBe('@maria_dev');
		expect(normalizeTelegram('https://t.me/maria_dev')).toBe('@maria_dev');
		expect(normalizeTelegram('maria_dev')).toBe('@maria_dev');
		expect(normalizeTelegram('@abc')).toBeNull();
		expect(normalizeTelegram('maria@mail.ru')).toBeNull();
	});
});

describe('soft skills', () => {
	it('finds a quality by its spellings as whole words, keeping the words of the text', () => {
		expect(
			softSkillsIn('Коммуникабельна, люблю работать в команде.').map((found) => [found.skill.key, found.written])
		).toEqual([
			['communication', 'Коммуникабельна'],
			['teamwork', 'работать в команде']
		]);
		expect(softSkillOf('Стрессоустойчивость')?.key).toBe('stress_resistance');
		expect(softSkillOf('коммуникабельность и стрессоустойчивость')).toBeNull();
		expect(softSkillOf('Ответственный за релизы')).toBeNull();
	});
});
