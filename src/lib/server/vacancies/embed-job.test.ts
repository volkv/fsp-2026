import { describe, expect, it } from 'vitest';
import { MAX_INPUT_CHARS } from '$lib/server/embeddings/text';
import { vacancyDocument, vacancyEmbedText } from './embed-job';

const vacancy = {
	title: 'Backend-разработчик',
	roleKey: 'backend',
	requiredSkillKeys: ['go', 'postgresql'],
	niceSkillKeys: ['kafka'],
	description: 'Требуется опытный инженер. '.repeat(2000)
};

describe('vacancyDocument', () => {
	it('joins the fields into one text without cutting it on its own', () => {
		expect(vacancyDocument(vacancy)).toBe(
			[
				'Backend-разработчик',
				'Роль: backend',
				'Обязательные навыки: go, postgresql',
				'Желательные навыки: kafka',
				vacancy.description
			].join('\n')
		);
		// A vacancy this long used to reach the model almost whole (the old 8000-character bound): the runtime refuses
		// anything past its own, much smaller limit, so the document on its own must stay unfit for the model.
		expect(vacancyDocument(vacancy).length).toBeGreaterThan(MAX_INPUT_CHARS);
	});
});

describe('vacancyEmbedText', () => {
	it('stays within the embedder input limit for a long vacancy, unlike the raw document', () => {
		const text = vacancyEmbedText(vacancy);
		expect(text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
		expect(text).toMatch(/^Backend-разработчик/);
	});

	it('keeps a short vacancy exactly, only cutting when the document does not fit', () => {
		const short = { ...vacancy, description: 'Пишем бэкенд на Go.' };
		expect(vacancyEmbedText(short)).toBe(vacancyDocument(short));
	});
});
