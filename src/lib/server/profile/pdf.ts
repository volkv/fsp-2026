// The PDF profile of a candidate (ТЗ: «автогенерация стандартизированного PDF-профиля»; docs/domain.md, section 12.9):
// one layout for everybody — the name and the contacts the candidate chose, the confirmed category with a QR code to its
// signed confirmation, the stack by how it is known, the experience, the FSP achievements with their receipts and the
// soft skills as stated. The QR code is drawn as vector squares from the QR matrix of the address, with a link over it,
// so it scans from print and opens from the screen.
//
// The page follows the FSP brandbook: a dark head with the logo, the sign and the pattern strip, JetBrains Mono for
// headings and labels, Inter for running text, the logo blue for what the platform signs. How a fact is known is shown
// by its look, the same everywhere: filled blue — confirmed by the test, outlined — stated, grey — read from the resume.
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { FSP_LOGO, type LogoPart } from '$lib/components/brand/logo';
import { PATTERN_TILE, PATTERN_TILES, type PatternTone } from '$lib/components/brand/pattern';

export interface ProfilePdfCategory {
	/** «Backend · Middle». */
	title: string;
	blocks: string[];
	skills: string[];
	decidedOn: string;
	catalogVersion: string;
	bankReleaseId: string;
	verifyUrl: string;
	/** How the clusters of the attempt were judged (domain 10.8); `null` — signed by people. */
	judgementNote: string | null;
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

export interface ProfilePdfAchievement {
	title: string;
	detail: string | null;
	/** The place taken, when the result has one: it goes on the medal. */
	place: number | null;
	receiptUrl: string | null;
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
	achievements: ProfilePdfAchievement[];
	softSkills: string[];
	issuedOn: string;
	origin: string;
}

export interface ProfilePdfFonts {
	regular: Uint8Array;
	semibold: Uint8Array;
	mono: Uint8Array;
	monoBold: Uint8Array;
}

type Font = 'regular' | 'semibold' | 'mono' | 'monoBold';
type Doc = PDFKit.PDFDocument;

/** A4; the top margin leaves room for the running head of the pages after the first, the bottom one for the footer. */
const MARGIN = { top: 64, bottom: 60, left: 44, right: 44 } as const;
/** The FSP brandbook palette on paper: #1B1C21 ink and its greys, the logo blue and red, a pale blue for signed facts. */
const COLORS = {
	ink: '#1b1c21',
	ink2: '#3d3e45',
	muted: '#6c6d75',
	faint: '#9d9ea5',
	rule: '#e2e2e6',
	soft: '#f4f4f6',
	accent: '#402fff',
	accentSoft: '#ecebff',
	accentPale: '#f8f8ff',
	accentInk: '#2c1fd9',
	red: '#ec1d35',
	onDark: '#ededed',
	onDarkMuted: '#a5a6ad',
	white: '#ffffff'
} as const;
/** The logo and the pattern on the dark head (brandbook: light node and lettering #EDEDED on a dark surface). */
const DARK_FILLS: Record<LogoPart | PatternTone, string> = {
	light: COLORS.onDark,
	lettering: COLORS.onDark,
	ink: COLORS.onDark,
	red: COLORS.red,
	blue: '#6a5cff'
};
/** The logo on paper (brandbook: light node #C8C9CA, lettering #1B1C21). */
const LIGHT_FILLS: Record<LogoPart, string> = {
	light: '#c8c9ca',
	lettering: COLORS.ink,
	red: COLORS.red,
	blue: COLORS.accent
};
const LOGO_HEIGHT = 24;
/** Whole tiles of the pattern across the content width. */
const STRIP_TILES = 8;
const QR_SIZE = 92;
const QR_PAD = 7;
/** The column of the stack labels and of the experience periods. */
const LABEL_COLUMN = 118;

/** The dark modules of the QR code of a text, row by row: what the page draws. */
export function qrModules(text: string): { size: number; dark: [number, number][] } {
	const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
	const dark: [number, number][] = [];
	for (let row = 0; row < modules.size; row++) {
		for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) dark.push([row, col]);
	}
	return { size: modules.size, dark };
}

function contentWidth(doc: Doc): number {
	return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Starts a new page when the next `height` points do not fit on this one. */
function ensureSpace(doc: Doc, height: number): void {
	if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** The address without the scheme: what is printed next to a link. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//u, '');

interface TextStyle {
	font: Font;
	size: number;
	color?: string;
	width?: number;
	lineGap?: number;
	spacing?: number;
	align?: 'left' | 'right' | 'center';
	link?: string;
}

function measure(doc: Doc, text: string, style: TextStyle): number {
	doc.font(style.font).fontSize(style.size);
	return doc.heightOfString(text, {
		width: style.width,
		lineGap: style.lineGap ?? 0,
		characterSpacing: style.spacing ?? 0
	});
}

function textWidth(doc: Doc, text: string, style: Pick<TextStyle, 'font' | 'size' | 'spacing'>): number {
	doc.font(style.font).fontSize(style.size);
	return doc.widthOfString(text, { characterSpacing: style.spacing ?? 0 });
}

/** Draws a text block at a place and returns its height; the cursor of the document stays where it was. */
function put(doc: Doc, text: string, x: number, y: number, style: TextStyle): number {
	const height = measure(doc, text, style);
	const { x: keepX, y: keepY } = doc;
	doc
		.font(style.font)
		.fontSize(style.size)
		.fillColor(style.color ?? COLORS.ink)
		.text(text, x, y, {
			width: style.width,
			lineGap: style.lineGap ?? 0,
			characterSpacing: style.spacing ?? 0,
			align: style.align ?? 'left',
			lineBreak: style.width !== undefined,
			link: style.link
		});
	doc.x = keepX;
	doc.y = keepY;
	return height;
}

interface ChipStyle {
	font: Font;
	size: number;
	color: string;
	fill?: string;
	stroke?: string;
	height: number;
	padX: number;
}

/** The looks of a fact by how it is known, and the small grey one of the skills of a job. */
const CHIP = {
	confirmed: { font: 'mono', size: 8, color: COLORS.white, fill: COLORS.accent, height: 17, padX: 8 },
	confirmedSoft: { font: 'mono', size: 8, color: COLORS.accentInk, fill: COLORS.accentSoft, height: 17, padX: 8 },
	stated: { font: 'mono', size: 8, color: COLORS.ink, stroke: '#c8c9ca', height: 17, padX: 8 },
	resume: { font: 'mono', size: 8, color: COLORS.ink2, fill: COLORS.soft, height: 17, padX: 8 },
	small: { font: 'mono', size: 7, color: COLORS.ink2, fill: COLORS.soft, height: 13, padX: 5 }
} as const satisfies Record<string, ChipStyle>;

interface ChipLayout {
	chips: { text: string; x: number; y: number; width: number }[];
	height: number;
}

/** Lays chips out in rows within a width. */
function layoutChips(doc: Doc, items: string[], width: number, style: ChipStyle, gap = 5): ChipLayout {
	const chips: ChipLayout['chips'] = [];
	let x = 0;
	let y = 0;
	for (const text of items) {
		const chipWidth = Math.min(width, textWidth(doc, text, style) + style.padX * 2);
		if (x > 0 && x + chipWidth > width) {
			x = 0;
			y += style.height + gap;
		}
		chips.push({ text, x, y, width: chipWidth });
		x += chipWidth + gap;
	}
	return { chips, height: items.length === 0 ? 0 : y + style.height };
}

function drawChips(doc: Doc, layout: ChipLayout, x: number, y: number, style: ChipStyle): void {
	const lineHeight = doc.font(style.font).fontSize(style.size).currentLineHeight();
	for (const chip of layout.chips) {
		const box = doc.roundedRect(x + chip.x, y + chip.y, chip.width, style.height, style.height / 2);
		if (style.fill !== undefined && style.stroke !== undefined)
			box.lineWidth(0.8).fillAndStroke(style.fill, style.stroke);
		else if (style.fill !== undefined) box.fill(style.fill);
		else if (style.stroke !== undefined) box.lineWidth(0.8).stroke(style.stroke);
		put(doc, chip.text, x + chip.x + style.padX, y + chip.y + (style.height - lineHeight) / 2 + 0.4, {
			font: style.font,
			size: style.size,
			color: style.color,
			width: chip.width - style.padX * 2 + 1
		});
	}
}

/** A small capitalised label of the mono face: captions of fields and blocks. */
function eyebrow(doc: Doc, text: string, x: number, y: number, color: string = COLORS.muted): number {
	return put(doc, text.toUpperCase(), x, y, { font: 'monoBold', size: 7, color, spacing: 0.9 });
}

/** A rectangle drawn as a path: the only `re` operators of the page stay the QR modules. */
function box(doc: Doc, x: number, y: number, width: number, height: number): Doc {
	return doc.polygon([x, y], [x + width, y], [x + width, y + height], [x, y + height]);
}

/** The logo at a place in the colours of its surface; `parts` limits it to some of them (the sign without lettering). */
function drawLogo(
	doc: Doc,
	x: number,
	y: number,
	height: number,
	fills: Record<LogoPart, string>,
	parts?: LogoPart[]
): number {
	const scale = height / FSP_LOGO.height;
	doc.save().translate(x, y).scale(scale);
	for (const path of FSP_LOGO.paths) {
		if (parts === undefined || parts.includes(path.part)) doc.path(path.d).fill(fills[path.part]);
	}
	doc.restore();
	return FSP_LOGO.width * scale;
}

function drawStrip(doc: Doc, x: number, y: number, width: number): void {
	const tileScale = width / (STRIP_TILES * PATTERN_TILE.width);
	for (let index = 0; index < STRIP_TILES; index++) {
		const glyphs = PATTERN_TILES[index % PATTERN_TILES.length];
		if (glyphs === undefined) throw new Error(`the pattern has no tile ${index % PATTERN_TILES.length}`);
		doc
			.save()
			.translate(x + index * PATTERN_TILE.width * tileScale, y)
			.scale(tileScale);
		for (const glyph of glyphs) doc.path(glyph.d).fill(DARK_FILLS[glyph.tone], 'even-odd');
		doc.restore();
	}
}

type Contact = ProfilePdfInput['contacts'][number];

/** The contacts of the head in rows: a small label before each value. */
function layoutContacts(doc: Doc, contacts: Contact[], width: number) {
	const placed: { contact: Contact; x: number; y: number; labelWidth: number }[] = [];
	const gap = 22;
	const rowHeight = 15;
	let x = 0;
	let y = 0;
	for (const contact of contacts) {
		const labelWidth = textWidth(doc, contact.label.toUpperCase(), { font: 'monoBold', size: 6.5, spacing: 0.9 }) + 6;
		const itemWidth = labelWidth + textWidth(doc, contact.value, { font: 'mono', size: 9 });
		if (x > 0 && x + itemWidth > width) {
			x = 0;
			y += rowHeight;
		}
		placed.push({ contact, x, y, labelWidth });
		x += itemWidth + gap;
	}
	return { placed, height: contacts.length === 0 ? 0 : y + rowHeight - 4 };
}

/**
 * The head of the first page, bled to the edges: the logo and «Карьера», the kind and the date of the document, the
 * name, the headline, the confirmed categories as badges, the contacts and the FSP pattern strip; the sign of the logo
 * stands large and faint at the right.
 */
function hero(doc: Doc, input: ProfilePdfInput): void {
	const left = doc.page.margins.left;
	const width = contentWidth(doc);
	const right = left + width;
	const top = 30;

	const nameStyle: TextStyle = { font: 'monoBold', size: 25, width: width - 40, lineGap: 1 };
	const headlineStyle: TextStyle = { font: 'regular', size: 11, width: width - 60, lineGap: 2 };
	const contacts = layoutContacts(doc, input.contacts, width);
	const nameTop = top + LOGO_HEIGHT + 36;
	const headlineTop = nameTop + measure(doc, input.name, nameStyle) + 6;
	const badgesTop = headlineTop + (input.headline === null ? 4 : measure(doc, input.headline, headlineStyle) + 16);
	const contactsTop = badgesTop + 22 + (contacts.height > 0 ? 18 : 0);
	const stripTop = contactsTop + contacts.height + 24;
	const stripHeight = (PATTERN_TILE.height * width) / (STRIP_TILES * PATTERN_TILE.width);
	const bottom = stripTop + stripHeight + 22;

	box(doc, 0, 0, doc.page.width, bottom).fill(COLORS.ink);
	doc.save();
	box(doc, 0, 0, doc.page.width, bottom).clip();
	doc.fillOpacity(0.07);
	const signHeight = bottom * 0.9;
	drawLogo(doc, doc.page.width - signHeight * 0.9, bottom * 0.24, signHeight, DARK_FILLS, ['light', 'red', 'blue']);
	doc.restore();

	const logoWidth = drawLogo(doc, left, top, LOGO_HEIGHT, DARK_FILLS);
	put(doc, '|  Карьера', left + logoWidth + 8, top + LOGO_HEIGHT / 2 - 8.5, {
		font: 'semibold',
		size: 14,
		color: COLORS.onDark
	});
	put(doc, 'ПРОФИЛЬ КАНДИДАТА', left, top + 2, {
		font: 'monoBold',
		size: 7.5,
		color: COLORS.onDark,
		spacing: 1.4,
		width,
		align: 'right'
	});
	put(doc, `сформирован ${input.issuedOn}`, left, top + 14, {
		font: 'mono',
		size: 7.5,
		color: COLORS.onDarkMuted,
		width,
		align: 'right'
	});

	put(doc, input.name, left, nameTop, { ...nameStyle, color: COLORS.white });
	if (input.headline !== null) put(doc, input.headline, left, headlineTop, { ...headlineStyle, color: '#c8c9ca' });

	let x = left;
	if (input.categories.length === 0) {
		const label = 'КАТЕГОРИЯ НЕ ПОДТВЕРЖДЕНА';
		const badgeWidth = textWidth(doc, label, { font: 'monoBold', size: 8, spacing: 0.9 }) + 22;
		doc.roundedRect(x, badgesTop, badgeWidth, 22, 6).lineWidth(0.8).stroke(COLORS.onDarkMuted);
		put(doc, label, x + 11, badgesTop + 6.5, { font: 'monoBold', size: 8, color: COLORS.onDarkMuted, spacing: 0.9 });
	} else {
		for (const item of input.categories) {
			const badgeWidth = textWidth(doc, item.title, { font: 'monoBold', size: 10.5 }) + 24;
			doc.roundedRect(x, badgesTop, badgeWidth, 22, 6).fill(COLORS.accent);
			put(doc, item.title, x + 12, badgesTop + 5, { font: 'monoBold', size: 10.5, color: COLORS.white });
			x += badgeWidth + 8;
		}
		const first = input.categories[0];
		if (first !== undefined && x < right - 200) {
			put(doc, `✓ подтверждено тестом платформы ${first.decidedOn}`, x + 4, badgesTop + 6, {
				font: 'regular',
				size: 8.5,
				color: COLORS.onDarkMuted
			});
		}
	}

	for (const { contact, x: itemX, y, labelWidth } of contacts.placed) {
		put(doc, contact.label.toUpperCase(), left + itemX, contactsTop + y + 2, {
			font: 'monoBold',
			size: 6.5,
			color: COLORS.onDarkMuted,
			spacing: 0.9
		});
		put(doc, contact.value, left + itemX + labelWidth, contactsTop + y, { font: 'mono', size: 9, color: COLORS.white });
	}

	drawStrip(doc, left, stripTop, width);
	doc.x = left;
	doc.y = bottom + 6;
}

/** How many sections each document has headed: they are numbered in order. */
const sectionCounts = new WeakMap<Doc, number>();

/** The head of a section: its number in blue, its name, a hairline to the edge and an optional note at the right. */
function heading(doc: Doc, title: string, next: number, note?: string): void {
	ensureSpace(doc, 48 + next);
	// At the top of a page the running head stands above: the space before the section is already there.
	if (doc.y > doc.page.margins.top) doc.y += 22;
	const left = doc.page.margins.left;
	const right = left + contentWidth(doc);
	const number = (sectionCounts.get(doc) ?? 0) + 1;
	sectionCounts.set(doc, number);
	const caption = title.toUpperCase();
	put(doc, String(number).padStart(2, '0'), left, doc.y, { font: 'monoBold', size: 9, color: COLORS.accent });
	const titleX = left + 22;
	put(doc, caption, titleX, doc.y, { font: 'monoBold', size: 10.5, color: COLORS.ink, spacing: 1.1 });
	let lineEnd = right;
	if (note !== undefined) {
		const noteWidth = textWidth(doc, note, { font: 'regular', size: 8 });
		put(doc, note, right - noteWidth, doc.y + 2, { font: 'regular', size: 8, color: COLORS.faint });
		lineEnd = right - noteWidth - 10;
	}
	const lineStart = titleX + textWidth(doc, caption, { font: 'monoBold', size: 10.5, spacing: 1.1 }) + 10;
	const lineY = doc.y + 7;
	if (lineEnd > lineStart) doc.moveTo(lineStart, lineY).lineTo(lineEnd, lineY).lineWidth(0.6).stroke(COLORS.rule);
	doc.y += 26;
}

function drawQr(doc: Doc, url: string, x: number, y: number, size: number): void {
	const { size: count, dark } = qrModules(url);
	const module = size / count;
	doc.save().fillColor('#000000');
	for (const [row, col] of dark) doc.rect(x + col * module, y + row * module, module, module);
	doc.fill().restore();
	doc.link(x, y, size, size, url);
}

/**
 * A confirmed category as a card: what was decided and when, the defining blocks and the confirmed stack, how the
 * answers were judged, and the QR code of the signed confirmation; under a rule — what the test does not assert.
 * Measured first (`draw: false`), then drawn over its background; returns the height.
 */
function categoryCard(doc: Doc, item: ProfilePdfCategory, x: number, y: number, width: number, draw: boolean): number {
	const pad = 18;
	const tile = QR_SIZE + QR_PAD * 2;
	const textLeft = x + pad;
	const textColumn = width - pad * 2 - tile - 22;
	const tileX = x + width - pad - tile;
	let cursor = y + pad;
	const text = (value: string, style: TextStyle, left = textLeft) => {
		cursor += draw ? put(doc, value, left, cursor, style) : measure(doc, value, style);
	};

	if (draw) eyebrow(doc, 'Подтверждённая категория', textLeft, cursor, COLORS.accent);
	cursor += 13;
	text(item.title, { font: 'monoBold', size: 20, width: textColumn, color: COLORS.ink });
	cursor += 4;
	text(
		`Решение теста от ${item.decidedOn} · справочник ${item.catalogVersion} · выпуск банка заданий ${item.bankReleaseId}`,
		{ font: 'regular', size: 8, width: textColumn, color: COLORS.muted, lineGap: 1.5 }
	);
	const groups: [string, string[], ChipStyle][] = [
		['Определяющие блоки', item.blocks, CHIP.confirmed],
		['Подтверждённый стек', item.skills, CHIP.confirmedSoft]
	];
	for (const [label, values, style] of groups) {
		if (values.length === 0) continue;
		cursor += 12;
		if (draw) eyebrow(doc, label, textLeft, cursor);
		cursor += 12;
		const layout = layoutChips(doc, values, textColumn, style);
		if (draw) drawChips(doc, layout, textLeft, cursor, style);
		cursor += layout.height;
	}
	if (item.judgementNote !== null) {
		cursor += 10;
		text(item.judgementNote, { font: 'regular', size: 8, width: textColumn, color: COLORS.muted, lineGap: 1.5 });
	}

	const tileTop = y + pad;
	const caption = 'Сканируйте, чтобы проверить подпись платформы';
	const captionStyle: TextStyle = {
		font: 'regular',
		size: 7,
		width: tile,
		align: 'center',
		color: COLORS.muted,
		lineGap: 1
	};
	if (draw) {
		doc.roundedRect(tileX, tileTop, tile, tile, 8).lineWidth(0.8).fillAndStroke(COLORS.white, COLORS.rule);
		drawQr(doc, item.verifyUrl, tileX + QR_PAD, tileTop + QR_PAD, QR_SIZE);
		put(doc, caption, tileX, tileTop + tile + 6, captionStyle);
	}
	cursor = Math.max(cursor, tileTop + tile + 6 + measure(doc, caption, captionStyle)) + 14;

	if (draw)
		doc
			.moveTo(x + pad, cursor)
			.lineTo(x + width - pad, cursor)
			.lineWidth(0.6)
			.stroke(COLORS.accentSoft);
	cursor += 10;
	const full = width - pad * 2;
	text(`Тест не проверяет: ${item.doesNotAssert.join('; ')}.`, {
		font: 'regular',
		size: 7.5,
		width: full,
		color: COLORS.muted,
		lineGap: 1.5
	});
	cursor += 6;
	text(`Подписанное подтверждение  ↗  ${shortUrl(item.verifyUrl)}`, {
		font: 'mono',
		size: 7.5,
		width: full,
		color: COLORS.accent,
		link: item.verifyUrl
	});
	return cursor + pad - y;
}

function categorySection(doc: Doc, input: ProfilePdfInput): void {
	const left = doc.page.margins.left;
	const width = contentWidth(doc);
	if (input.categories.length === 0) {
		const message = input.withoutCategory ?? 'Категория не подтверждена тестом.';
		const style: TextStyle = { font: 'regular', size: 9.5, width: width - 36, color: COLORS.ink2, lineGap: 2 };
		const height = measure(doc, message, style) + 28;
		heading(doc, 'Категория', height);
		doc.roundedRect(left, doc.y, width, height, 10).lineWidth(0.8).dash(3, { space: 3 }).stroke('#c8c9ca').undash();
		put(doc, message, left + 18, doc.y + 14, style);
		doc.y += height;
		return;
	}
	const heights = input.categories.map((item) => categoryCard(doc, item, left, 0, width, false));
	heading(doc, 'Категория', heights[0] ?? 0);
	input.categories.forEach((item, index) => {
		const height = heights[index] ?? 0;
		if (index > 0) {
			doc.y += 10;
			ensureSpace(doc, height);
		}
		const top = doc.y;
		doc.roundedRect(left, top, width, height, 12).lineWidth(0.9).fillAndStroke(COLORS.accentPale, COLORS.accent);
		categoryCard(doc, item, left, top, width, true);
		doc.y = top + height;
	});
}

function stackSection(doc: Doc, input: ProfilePdfInput): void {
	const rows = (
		[
			['Подтверждён тестом', 'подпись платформы', input.stack.confirmed, CHIP.confirmed],
			['Заявлен в опросе', 'со слов кандидата', input.stack.declared, CHIP.stated],
			['Из резюме', 'разбор резюме', input.stack.resume, CHIP.resume]
		] as [string, string, string[], ChipStyle][]
	).filter(([, , skills]) => skills.length > 0);
	if (rows.length === 0) return;
	const left = doc.page.margins.left;
	const chipsWidth = contentWidth(doc) - LABEL_COLUMN;
	const laidOut = rows.map(([label, source, skills, style]) => {
		const layout = layoutChips(doc, skills, chipsWidth, style);
		return { label, source, style, layout, height: Math.max(layout.height, 26) };
	});
	heading(doc, 'Стек', laidOut[0]?.height ?? 0);
	laidOut.forEach(({ label, source, style, layout, height }, index) => {
		if (index > 0) doc.y += 10;
		ensureSpace(doc, height);
		const top = doc.y;
		const swatch = doc.roundedRect(left, top + 3.5, 9, 9, 4.5);
		if (style.fill !== undefined) swatch.fill(style.fill);
		else swatch.lineWidth(0.8).stroke(style.stroke ?? COLORS.faint);
		put(doc, label, left + 15, top + 1.5, { font: 'semibold', size: 9, color: COLORS.ink });
		put(doc, source, left + 15, top + 14, { font: 'regular', size: 7.5, color: COLORS.faint });
		drawChips(doc, layout, left + LABEL_COLUMN, top, style);
		doc.y = top + height;
	});
}

/** A period «март 2024 г. — по настоящее время» as two lines at the dash. */
function periodLines(period: string): string {
	const [from, to] = period.split(' — ');
	return to === undefined ? period : `${from} —\n${to}`;
}

/** The jobs as a timeline: the period at the left, a dot on the rail (blue for the current job), the job at the right. */
function experienceSection(doc: Doc, input: ProfilePdfInput): void {
	if (input.experience.length === 0) return;
	const left = doc.page.margins.left;
	const rail = left + LABEL_COLUMN - 12;
	const body = left + LABEL_COLUMN;
	const bodyWidth = contentWidth(doc) - LABEL_COLUMN;
	const titleStyle: TextStyle = { font: 'semibold', size: 10.5, width: bodyWidth, lineGap: 1, color: COLORS.ink };
	const orgStyle: TextStyle = { font: 'regular', size: 9, width: bodyWidth, color: COLORS.ink2 };
	const periodStyle: TextStyle = { font: 'mono', size: 7.5, width: LABEL_COLUMN - 26, color: COLORS.muted, lineGap: 2 };

	const entries = input.experience.map((entry) => {
		const org = [entry.organization, entry.source === 'stated' ? 'указано кандидатом' : 'из резюме']
			.filter((part) => part !== null)
			.join('  ·  ');
		const skills = layoutChips(doc, entry.skills, bodyWidth, CHIP.small, 4);
		const height = Math.max(
			measure(doc, entry.title, titleStyle) +
				3 +
				measure(doc, org, orgStyle) +
				(skills.height > 0 ? 7 + skills.height : 0),
			measure(doc, periodLines(entry.period), periodStyle)
		);
		return { entry, org, skills, height };
	});
	heading(doc, 'Опыт работы', entries[0]?.height ?? 0, input.experienceTotal ?? undefined);

	entries.forEach(({ entry, org, skills, height }, index) => {
		ensureSpace(doc, height);
		const top = doc.y;
		const last = index === entries.length - 1;
		if (!last)
			doc
				.moveTo(rail, top + 10)
				.lineTo(rail, top + height + 22)
				.lineWidth(1)
				.stroke(COLORS.rule);
		if (/настоящее/u.test(entry.period)) {
			doc.circle(rail, top + 6, 6).fill(COLORS.accentSoft);
			doc.circle(rail, top + 6, 3.2).fill(COLORS.accent);
		} else {
			doc
				.circle(rail, top + 6, 3.2)
				.lineWidth(1.2)
				.fillAndStroke(COLORS.white, COLORS.faint);
		}
		put(doc, periodLines(entry.period), left, top + 1, periodStyle);
		let cursor = top;
		cursor += put(doc, entry.title, body, cursor, titleStyle) + 3;
		cursor += put(doc, org, body, cursor, orgStyle);
		if (skills.height > 0) drawChips(doc, skills, body, cursor + 7, CHIP.small);
		doc.y = top + height + (last ? 0 : 16);
	});
}

/** The medal of a result: the place in blue for the first, in ink for the second and the third, a star otherwise. */
function medal(doc: Doc, place: number | null, cx: number, cy: number): void {
	const radius = 14;
	if (place === null || place > 3) {
		doc.circle(cx, cy, radius).lineWidth(1).fillAndStroke(COLORS.white, COLORS.rule);
		const font: Font = place === null ? 'semibold' : 'monoBold';
		const size = place === null ? 11 : 10;
		const lineHeight = doc.font(font).fontSize(size).currentLineHeight();
		put(doc, place === null ? '★' : String(place), cx - radius, cy - lineHeight / 2, {
			font,
			size,
			width: radius * 2,
			align: 'center',
			color: COLORS.muted
		});
		return;
	}
	doc.circle(cx, cy, radius + 3).fill(place === 1 ? COLORS.accentSoft : COLORS.soft);
	doc.circle(cx, cy, radius).fill(place === 1 ? COLORS.accent : place === 2 ? COLORS.ink : '#5a5b63');
	const lineHeight = doc.font('monoBold').fontSize(12).currentLineHeight();
	put(doc, String(place), cx - radius, cy - lineHeight / 2 + 0.5, {
		font: 'monoBold',
		size: 12,
		width: radius * 2,
		align: 'center',
		color: COLORS.white
	});
}

function achievementsSection(doc: Doc, input: ProfilePdfInput): void {
	if (input.achievements.length === 0) return;
	const left = doc.page.margins.left;
	const width = contentWidth(doc);
	const body = left + 48;
	const bodyWidth = width - 48;
	const titleStyle: TextStyle = { font: 'semibold', size: 10, width: bodyWidth, lineGap: 1.5, color: COLORS.ink };
	const detailStyle: TextStyle = { font: 'regular', size: 8.5, width: bodyWidth, color: COLORS.muted };
	const entries = input.achievements.map((achievement) => {
		const link: [string, TextStyle] | null =
			achievement.receiptUrl === null
				? null
				: [
						`Квитанция проверки  ↗  ${shortUrl(achievement.receiptUrl)}`,
						{ font: 'mono', size: 7.5, width: bodyWidth, color: COLORS.accent, link: achievement.receiptUrl }
					];
		const height = Math.max(
			34,
			measure(doc, achievement.title, titleStyle) +
				(achievement.detail === null ? 0 : 3 + measure(doc, achievement.detail, detailStyle)) +
				(link === null ? 0 : 5 + measure(doc, ...link))
		);
		return { achievement, link, height };
	});
	heading(doc, 'Достижения ФСП', entries[0]?.height ?? 0, 'данные реестра Федерации спортивного программирования');
	entries.forEach(({ achievement, link, height }, index) => {
		ensureSpace(doc, height);
		const top = doc.y;
		medal(doc, achievement.place, left + 17, top + 16);
		let cursor = top + 1;
		cursor += put(doc, achievement.title, body, cursor, titleStyle);
		if (achievement.detail !== null) cursor += 3 + put(doc, achievement.detail, body, cursor + 3, detailStyle);
		if (link !== null) put(doc, link[0], body, cursor + 5, link[1]);
		doc.y = top + height;
		if (index < entries.length - 1) {
			doc.y += 10;
			doc
				.moveTo(body, doc.y)
				.lineTo(left + width, doc.y)
				.lineWidth(0.6)
				.stroke(COLORS.rule);
			doc.y += 10;
		}
	});
}

function softSkillsSection(doc: Doc, input: ProfilePdfInput): void {
	if (input.softSkills.length === 0) return;
	const layout = layoutChips(doc, input.softSkills, contentWidth(doc), CHIP.stated);
	heading(doc, 'Мягкие навыки', layout.height, 'со слов кандидата, тестом не проверяются');
	drawChips(doc, layout, doc.page.margins.left, doc.y, CHIP.stated);
	doc.y += layout.height;
}

/** What the document is and what the signature of the platform covers: the last block, on a grey ground. */
function colophon(doc: Doc, input: ProfilePdfInput): void {
	const left = doc.page.margins.left;
	const width = contentWidth(doc);
	const text =
		`Профиль сформирован ${input.issuedOn} на платформе ФСП Карьера (${shortUrl(input.origin)}). Подписью платформы ` +
		'подтверждено только то, к чему ведут QR-код и ссылки проверки; остальное заполнено кандидатом. Файл сделан для ' +
		'кандидата, платформа его не хранит.';
	const style: TextStyle = { font: 'regular', size: 7.5, width: width - 32, color: COLORS.muted, lineGap: 1.5 };
	const height = 28 + measure(doc, text, style) + 14;
	doc.y += 26;
	ensureSpace(doc, height);
	const top = doc.y;
	doc.roundedRect(left, top, width, height, 10).fill(COLORS.soft);
	eyebrow(doc, 'О документе', left + 16, top + 14, COLORS.ink2);
	put(doc, text, left + 16, top + 28, style);
	doc.y = top + height;
}

/** The running head of the pages after the first: the short logo, the name and the kind of the document. */
function runningHead(doc: Doc, name: string): void {
	const left = doc.page.margins.left;
	const width = contentWidth(doc);
	drawLogo(doc, left, 26, 14, LIGHT_FILLS);
	put(doc, `${name}  ·  профиль кандидата`.toUpperCase(), left, 30, {
		font: 'monoBold',
		size: 6.5,
		color: COLORS.faint,
		spacing: 0.9,
		width,
		align: 'right'
	});
	doc
		.moveTo(left, 48)
		.lineTo(left + width, 48)
		.lineWidth(0.6)
		.stroke(COLORS.rule);
}

/** The footer of every page: the platform, the name and the page number; drawn last, over the buffered pages. */
function footers(doc: Doc, input: ProfilePdfInput): void {
	const range = doc.bufferedPageRange();
	for (let index = range.start; index < range.start + range.count; index++) {
		doc.switchToPage(index);
		const left = doc.page.margins.left;
		const width = contentWidth(doc);
		// Text under the bottom margin would open a new page; the footer is drawn with the margin lifted.
		const keep = doc.page.margins.bottom;
		doc.page.margins.bottom = 0;
		const y = doc.page.height - 36;
		doc
			.moveTo(left, y - 8)
			.lineTo(left + width, y - 8)
			.lineWidth(0.6)
			.stroke(COLORS.rule);
		put(doc, `ФСП Карьера  ·  ${input.name}  ·  ${shortUrl(input.origin)}`, left, y, {
			font: 'regular',
			size: 7,
			color: COLORS.faint
		});
		put(doc, `${index - range.start + 1} / ${range.count}`, left, y, {
			font: 'mono',
			size: 7,
			color: COLORS.muted,
			width,
			align: 'right'
		});
		doc.page.margins.bottom = keep;
	}
}

/** Renders the profile; `compress: false` keeps the page content readable (tests look into it). */
export function renderProfilePdf(
	input: ProfilePdfInput,
	fonts: ProfilePdfFonts,
	options: { compress?: boolean } = {}
): Promise<Buffer> {
	const doc = new PDFDocument({
		size: 'A4',
		margins: MARGIN,
		bufferPages: true,
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
	doc.registerFont('mono', Buffer.from(fonts.mono));
	doc.registerFont('monoBold', Buffer.from(fonts.monoBold));
	doc.on('pageAdded', () => {
		runningHead(doc, input.name);
	});

	hero(doc, input);
	categorySection(doc, input);
	stackSection(doc, input);
	experienceSection(doc, input);
	achievementsSection(doc, input);
	softSkillsSection(doc, input);
	colophon(doc, input);
	footers(doc, input);
	doc.end();
	return done;
}
