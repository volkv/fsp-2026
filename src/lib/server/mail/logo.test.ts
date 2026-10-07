import { describe, expect, it } from 'vitest';
import { inlineAttachments, MAIL_LOGO, MAIL_LOGO_CID } from './logo';
import { render, verifyEmailLetter } from './templates';

describe('logo of the letters', () => {
	it('travels inside every letter that shows it, as an inline PNG under the referenced Content-ID', () => {
		const letter = verifyEmailLetter('user@example.com', 'https://career.example/verify?token=t');
		expect(letter.html).toContain(`src="cid:${MAIL_LOGO_CID}"`);
		const [logo, ...rest] = inlineAttachments(letter.html);
		expect(rest).toEqual([]);
		expect(logo).toMatchObject({ cid: MAIL_LOGO_CID, contentType: 'image/png', contentDisposition: 'inline' });
		const png = Buffer.from(MAIL_LOGO.base64, 'base64');
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	});

	it('is not attached to a message that does not show it', () => {
		expect(inlineAttachments('<p>Без логотипа</p>')).toEqual([]);
		const rendered = render('user@example.com', { subject: 'Тема', paragraphs: ['Текст'], footnote: 'Сноска' });
		expect(inlineAttachments(rendered.html)).toHaveLength(1);
	});
});
