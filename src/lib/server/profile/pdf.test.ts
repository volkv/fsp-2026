import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { qrModules, renderProfilePdf, type ProfilePdfInput } from './pdf';

const fonts = {
	regular: readFileSync(new URL('./fonts/Inter-Regular.ttf', import.meta.url)),
	semibold: readFileSync(new URL('./fonts/Inter-SemiBold.ttf', import.meta.url))
};

const VERIFY_URL = 'https://career.example/verify/categories/abcdefghijklmnopqrstuvwxyz';

const input: ProfilePdfInput = {
	name: 'Иванова Мария Сергеевна',
	headline: 'Backend-разработчик',
	contacts: [{ label: 'Телефон', value: '+79123456789' }],
	categories: [
		{
			title: 'Backend · Middle',
			blocks: ['Базы данных', 'Конкурентность'],
			skills: ['PostgreSQL', 'Go'],
			decidedOn: '1 октября 2026 г.',
			catalogVersion: '2026.10.2',
			bankReleaseId: 'bank-2026.10.1',
			verifyUrl: VERIFY_URL,
			judgementNote: 'Рубрики заданий проверены независимыми моделями — их подтверждают эксперты.',
			doesNotAssert: ['Работу в команде']
		}
	],
	withoutCategory: null,
	stack: { confirmed: ['PostgreSQL', 'Go'], declared: ['Kafka'], resume: [] },
	experience: [
		{
			title: 'Разработчик',
			organization: 'ООО «Пример»',
			period: 'март 2021 г. — по настоящее время',
			skills: ['Go'],
			source: 'resume'
		}
	],
	experienceTotal: null,
	achievements: [{ title: 'Чемпионат России, 2025', detail: 'Победитель', receiptUrl: null }],
	softSkills: ['Работа в команде'],
	issuedOn: '5 октября 2026 г.',
	origin: 'https://career.example'
};

describe('PDF profile', () => {
	it('is a PDF whose QR code is the code of the confirmation address, with a link over it', async () => {
		const pdf = await renderProfilePdf(input, fonts, { compress: false });
		const text = pdf.toString('latin1');
		expect(text.startsWith('%PDF-')).toBe(true);
		expect(text).toContain(`/URI (${VERIFY_URL})`);
		// Every dark module of the QR code of the address is one square of the page, and no other square is drawn.
		const { dark } = qrModules(VERIFY_URL);
		expect(dark.length).toBeGreaterThan(100);
		expect(text.match(/ re$/gmu)?.length).toBe(dark.length);
		expect(qrModules('https://career.example/verify/categories/zzzzzzzzzzzzzzzzzzzzzzzzzz').dark).not.toEqual(dark);
	});

	it('renders a profile without a category, compressed', async () => {
		const pdf = await renderProfilePdf(
			{ ...input, categories: [], withoutCategory: 'Категория не подтверждена тестом платформы.' },
			fonts
		);
		const text = pdf.toString('latin1');
		expect(text.startsWith('%PDF-')).toBe(true);
		expect(text).not.toContain('/URI (');
	});
});
