// The PDF profile of a candidate (ТЗ: «автогенерация стандартизированного PDF-профиля»; docs/domain.md, section 12.9):
// one layout for everybody — the name and the contacts the candidate chose, the confirmed category with a QR code to its
// signed confirmation, the stack by how it is known, the experience, the FSP achievements with their receipts and the
// soft skills as stated. The QR code is drawn as vector squares from the QR matrix of the address, with a link over it,
// so it scans from print and opens from the screen.
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export interface ProfilePdfCategory {
	/** «Backend · Middle». */
	title: string;
	blocks: string[];
	skills: string[];
	decidedOn: string;
	catalogVersion: string;
	bankReleaseId: string;
	verifyUrl: string;
	doesNotAssert: string[];
}

export interface ProfilePdfExperience {
	title: string;
	organization: string | null;
	period: string;
	skills: string[];
	/** Where the entry comes from: the resume (with a quote behind it) or the candidate's own word. */
	source: 'resume' | 'stated';
}

export interface ProfilePdfInput {
	name: string;
	headline: string | null;
	contacts: { label: string; value: string }[];
	categories: ProfilePdfCategory[];
	/** What stands instead of a category when none is confirmed: the declared grade or the way to one. */
	withoutCategory: string | null;
	stack: { confirmed: string[]; declared: string[]; resume: string[] };
	experience: ProfilePdfExperience[];
	experienceTotal: string | null;
	achievements: { title: string; detail: string | null; receiptUrl: string | null }[];
	softSkills: string[];
	issuedOn: string;
	origin: string;
}

export interface ProfilePdfFonts {
	regular: Uint8Array;
	semibold: Uint8Array;
}

const PAGE = { size: 'A4', margin: 48 } as const;
const QR_SIZE = 112;
const COLORS = { text: '#111827', muted: '#4b5563', rule: '#d1d5db', accent: '#1d4ed8' } as const;

/** The dark modules of the QR code of a text, row by row: what the page draws. */
export function qrModules(text: string): { size: number; dark: [number, number][] } {
	const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
	const dark: [number, number][] = [];
	for (let row = 0; row < modules.size; row++) {
		for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) dark.push([row, col]);
	}
	return { size: modules.size, dark };
}

type Doc = PDFKit.PDFDocument;

function contentWidth(doc: Doc): number {
	return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Starts a new page when the next `height` points do not fit on this one. */
function ensureSpace(doc: Doc, height: number): void {
	if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function heading(doc: Doc, text: string): void {
	ensureSpace(doc, 48);
	doc.moveDown(0.8);
	doc.font('semibold').fontSize(12).fillColor(COLORS.text).text(text);
	const y = doc.y + 2;
	doc
		.moveTo(doc.page.margins.left, y)
		.lineTo(doc.page.margins.left + contentWidth(doc), y)
		.lineWidth(0.5)
		.strokeColor(COLORS.rule)
		.stroke();
	doc.moveDown(0.5);
}

function paragraph(doc: Doc, text: string, options: { muted?: boolean; size?: number; width?: number } = {}): void {
	doc
		.font('regular')
		.fontSize(options.size ?? 10)
		.fillColor(options.muted ? COLORS.muted : COLORS.text)
		.text(text, { width: options.width ?? contentWidth(doc), lineGap: 2 });
}

function labelled(doc: Doc, label: string, value: string, width?: number): void {
	doc
		.font('semibold')
		.fontSize(10)
		.fillColor(COLORS.text)
		.text(`${label}: `, { continued: true, width: width ?? contentWidth(doc), lineGap: 2 })
		.font('regular')
		.text(value);
}

function drawQr(doc: Doc, url: string, x: number, y: number): void {
	const { size, dark } = qrModules(url);
	const module = QR_SIZE / size;
	doc.save().fillColor('#000000');
	for (const [row, col] of dark) doc.rect(x + col * module, y + row * module, module, module);
	doc.fill().restore();
	doc.link(x, y, QR_SIZE, QR_SIZE, url);
}

function category(doc: Doc, item: ProfilePdfCategory): void {
	ensureSpace(doc, QR_SIZE + 24);
	const left = doc.page.margins.left;
	const top = doc.y;
	const textWidth = contentWidth(doc) - QR_SIZE - 16;
	drawQr(doc, item.verifyUrl, left + textWidth + 16, top);
	doc.x = left;
	doc.y = top;
	doc.font('semibold').fontSize(14).fillColor(COLORS.text).text(item.title, { width: textWidth });
	doc.moveDown(0.3);
	labelled(doc, 'Подтверждено тестом платформы', item.decidedOn, textWidth);
	if (item.blocks.length > 0) labelled(doc, 'Определяющие блоки', item.blocks.join(', '), textWidth);
	if (item.skills.length > 0) labelled(doc, 'Подтверждённый стек', item.skills.join(', '), textWidth);
	paragraph(doc, `Версия справочника ${item.catalogVersion}, выпуск банка заданий ${item.bankReleaseId}.`, {
		muted: true,
		size: 9,
		width: textWidth
	});
	paragraph(doc, `Не проверяется: ${item.doesNotAssert.join('; ')}.`, { muted: true, size: 9, width: textWidth });
	doc
		.font('regular')
		.fontSize(9)
		.fillColor(COLORS.accent)
		.text(`Проверить подписанное подтверждение: ${item.verifyUrl}`, {
			width: textWidth,
			link: item.verifyUrl,
			underline: true
		});
	doc.x = left;
	doc.y = Math.max(doc.y, top + QR_SIZE) + 8;
}

/** Renders the profile; `compress: false` keeps the page content readable (tests look into it). */
export function renderProfilePdf(
	input: ProfilePdfInput,
	fonts: ProfilePdfFonts,
	options: { compress?: boolean } = {}
): Promise<Buffer> {
	const doc = new PDFDocument({
		size: PAGE.size,
		margin: PAGE.margin,
		compress: options.compress ?? true,
		lang: 'ru-RU',
		displayTitle: true,
		info: { Title: `Профиль кандидата — ${input.name}`, Producer: 'ФСП Карьера', Creator: 'ФСП Карьера' }
	});
	const chunks: Buffer[] = [];
	const done = new Promise<Buffer>((resolve, reject) => {
		doc.on('data', (chunk: Buffer) => chunks.push(chunk));
		doc.on('end', () => {
			resolve(Buffer.concat(chunks));
		});
		doc.on('error', reject);
	});
	doc.registerFont('regular', Buffer.from(fonts.regular));
	doc.registerFont('semibold', Buffer.from(fonts.semibold));

	doc.font('semibold').fontSize(20).fillColor(COLORS.text).text(input.name);
	if (input.headline !== null) paragraph(doc, input.headline, { size: 12 });
	if (input.contacts.length > 0) {
		doc.moveDown(0.3);
		paragraph(doc, input.contacts.map((contact) => `${contact.label}: ${contact.value}`).join('   ·   '), {
			muted: true
		});
	}

	heading(doc, 'Категория');
	if (input.categories.length === 0) paragraph(doc, input.withoutCategory ?? 'Категория не подтверждена тестом.');
	for (const item of input.categories) category(doc, item);

	const stackLines: [string, string[]][] = [
		['Подтверждён тестом', input.stack.confirmed],
		['Заявлен в опросе', input.stack.declared],
		['Из резюме', input.stack.resume]
	];
	if (stackLines.some(([, skills]) => skills.length > 0)) {
		heading(doc, 'Стек');
		for (const [label, skills] of stackLines) if (skills.length > 0) labelled(doc, label, skills.join(', '));
	}

	if (input.experience.length > 0) {
		heading(doc, 'Опыт работы');
		if (input.experienceTotal !== null) {
			paragraph(doc, input.experienceTotal, { muted: true, size: 9 });
			doc.moveDown(0.3);
		}
		for (const entry of input.experience) {
			ensureSpace(doc, 40);
			doc
				.font('semibold')
				.fontSize(10)
				.fillColor(COLORS.text)
				.text(entry.organization === null ? entry.title : `${entry.title} · ${entry.organization}`);
			paragraph(doc, `${entry.period}${entry.source === 'stated' ? ' · указано кандидатом' : ' · из резюме'}`, {
				muted: true,
				size: 9
			});
			if (entry.skills.length > 0) paragraph(doc, entry.skills.join(', '), { size: 9 });
			doc.moveDown(0.4);
		}
	}

	if (input.achievements.length > 0) {
		heading(doc, 'Достижения ФСП');
		for (const achievement of input.achievements) {
			ensureSpace(doc, 32);
			doc.font('regular').fontSize(10).fillColor(COLORS.text).text(achievement.title, { lineGap: 2 });
			if (achievement.detail !== null) paragraph(doc, achievement.detail, { muted: true, size: 9 });
			if (achievement.receiptUrl !== null) {
				doc
					.font('regular')
					.fontSize(9)
					.fillColor(COLORS.accent)
					.text(`Квитанция проверки: ${achievement.receiptUrl}`, { link: achievement.receiptUrl, underline: true });
			}
			doc.moveDown(0.3);
		}
	}

	if (input.softSkills.length > 0) {
		heading(doc, 'Мягкие навыки');
		paragraph(doc, `${input.softSkills.join(', ')} — со слов кандидата, тестом не проверяются.`);
	}

	doc.moveDown(1.2);
	paragraph(
		doc,
		`Профиль сформирован ${input.issuedOn} на платформе ФСП Карьера (${input.origin}). Подписью платформы подтверждено ` +
			'только то, к чему ведут QR-код и ссылки проверки; остальное заполнено кандидатом.',
		{ muted: true, size: 8 }
	);
	doc.end();
	return done;
}
