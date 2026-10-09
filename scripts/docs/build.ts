// Builds the submission documentation: build/docs/fsp-career-documentation.pdf and .docx from the sections in
// docs/submission. Steps: the technologies table (licenses.ts, fails on a forbidden licence) and the API overview
// (api.ts) are generated into docs/submission/generated; the sections are joined in SECTIONS order; Mermaid blocks are
// rendered by mermaid-cli (SVG for the PDF, PNG for the DOCX — older Word does not show SVG); pandoc turns the result
// into HTML and DOCX (styles, A4 page and footer from a reference document built by docx-reference.lua, the table of
// contents and page breaks from docx.lua); Chromium from Playwright prints the HTML to PDF with page numbers and
// bookmarks. pandoc and
// mermaid-cli run in pinned containers (images.ts), so the build needs only Docker and the installed dependencies.
// Runs with plain Node: `pnpm docs:build`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { generateApi } from './api.ts';
import { MERMAID_IMAGE, PANDOC_IMAGE } from './images.ts';
import { generateTechnologies, ROOT } from './licenses.ts';

const SUBMISSION = join(ROOT, 'docs/submission');
const OUT = join(ROOT, 'build/docs');
const WORK = join(OUT, 'work');
const NAME = 'fsp-career-documentation';
/** PNG diagrams for the DOCX are rendered at this multiple of their size, so they stay sharp when printed. */
const PNG_SCALE = 2;

/** Sections in document order; a section may be followed by generated parts it introduces. */
const SECTIONS: readonly (readonly string[])[] = [
	['01-solution.md'],
	['02-functional-scheme.md'],
	['03-component-scheme.md'],
	['04-testing.md'],
	['05-matching.md'],
	['06-validation.md'],
	['07-fsp-registry.md'],
	['08-api.md', 'generated/api.md'],
	['09-deployment.md'],
	['10-user-guide.md'],
	['11-antifraud.md'],
	['12-ats.md'],
	['13-technologies.md', 'generated/technologies.md']
];

/** Every section file is in SECTIONS and every listed file exists: a new section cannot silently stay out. */
function checkSections(): void {
	const listed = new Set(SECTIONS.map((parts) => parts[0]));
	const present = readdirSync(SUBMISSION).filter((name) => name.endsWith('.md'));
	const unlisted = present.filter((name) => !listed.has(name));
	const missing = [...listed].filter((name) => name !== undefined && !present.includes(name));
	if (unlisted.length > 0 || missing.length > 0) {
		throw new Error(
			`docs/submission and SECTIONS in scripts/docs/build.ts differ: not listed ${unlisted.join(', ') || '—'}; ` +
				`missing ${missing.join(', ') || '—'}`
		);
	}
}

function git(...args: string[]): string {
	return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
}

function revision(): string {
	const head = git('rev-parse', '--short=12', 'HEAD');
	return git('status', '--porcelain') === '' ? head : `${head}-dirty`;
}

/** Runs a container with the work directory mounted at /data, as the current user, without network; returns stdout. */
function docker(image: string, args: readonly string[], entrypoint?: string): Buffer {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	return execFileSync(
		'docker',
		[
			'run',
			'--rm',
			'--network',
			'none',
			...(uid === undefined || gid === undefined ? [] : ['-u', `${uid}:${gid}`]),
			'-v',
			`${WORK}:/data`,
			'-w',
			'/data',
			...(entrypoint === undefined ? [] : ['--entrypoint', entrypoint]),
			image,
			...args
		],
		{ stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }
	);
}

/** Renders the Mermaid blocks of document.md into images; returns the Markdown for HTML and for DOCX. */
function renderDiagrams(markdown: string): { html: string; docx: string } {
	const count = markdown.match(/^```mermaid[ \t]*$/gm)?.length ?? 0;
	if (count === 0) return { html: 'document.md', docx: 'document.md' };
	writeFileSync(join(WORK, 'mermaid.json'), JSON.stringify({ theme: 'neutral' }));
	mkdirSync(join(WORK, 'diagrams-svg'));
	mkdirSync(join(WORK, 'diagrams-png'));
	const common = ['-i', 'document.md', '-c', 'mermaid.json', '-b', 'white', '-q'];
	docker(MERMAID_IMAGE, [...common, '-o', 'document-svg.md', '-e', 'svg', '-a', 'diagrams-svg']);
	docker(MERMAID_IMAGE, [...common, '-o', 'document-png.md', '-e', 'png', '-s', String(PNG_SCALE), '-a', 'diagrams-png']);
	console.log(`Diagrams: ${count}`);
	return { html: 'document-svg.md', docx: 'document-png.md' };
}

function pandoc(input: string, output: string, extra: readonly string[], metadata: Record<string, string>): void {
	docker(PANDOC_IMAGE, [
		input,
		'--from',
		// No implicit figures: mermaid-cli gives every diagram the alt text "diagram", which would become its caption.
		// ASCII identifiers: Cyrillic headings otherwise become percent-encoded anchors longer than the 127 bytes a PDF
		// name may have, and Word bookmarks are limited to 40 characters.
		'markdown-implicit_figures+ascii_identifiers',
		'--number-sections',
		...Object.entries(metadata).flatMap(([key, value]) => ['--metadata', `${key}=${value}`]),
		...extra,
		'--output',
		output
	]);
}

async function printPdf(html: string, pdf: string): Promise<void> {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.goto(`file://${html}`, { waitUntil: 'load' });
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		await page.pdf({
			path: pdf,
			format: 'A4',
			margin: { top: '18mm', bottom: '20mm', left: '20mm', right: '18mm' },
			printBackground: true,
			displayHeaderFooter: true,
			headerTemplate: '<span></span>',
			footerTemplate:
				'<div style="width:100%;font-size:8pt;color:#5b6270;text-align:center;font-family:sans-serif">' +
				'<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
			outline: true,
			tagged: true
		});
	} finally {
		await browser.close();
	}
}

async function main(): Promise<void> {
	checkSections();
	const { groups, excepted } = generateTechnologies();
	console.log(
		`Technologies: ${groups.reduce((sum, group) => sum + group.components.length, 0)} rows, ${excepted.length} exceptions`
	);
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(WORK, { recursive: true });
	const { json, operations } = generateApi();
	writeFileSync(join(OUT, 'openapi.json'), json);
	console.log(`API: ${operations} operations`);

	const markdown = SECTIONS.flat()
		.map((file) => readFileSync(join(SUBMISSION, file), 'utf8').trim())
		.join('\n\n');
	writeFileSync(join(WORK, 'document.md'), `${markdown}\n`);
	cpSync(join(ROOT, 'static/fonts'), join(WORK, 'fonts'), { recursive: true });
	copyFileSync(join(ROOT, 'scripts/docs/document.css'), join(WORK, 'document.css'));
	for (const script of ['docx.lua', 'docx-reference.lua']) {
		copyFileSync(join(ROOT, 'scripts/docs', script), join(WORK, script));
	}

	const sources = renderDiagrams(markdown);
	const date = new Date().toISOString().slice(0, 10);
	const metadata = {
		title: 'ФСП Карьера',
		subtitle: 'Сопроводительная документация решения',
		author: 'Wine Coding Team',
		date: `${date}, ревизия ${revision()}`,
		lang: 'ru',
		'toc-title': 'Содержание'
	};
	pandoc(sources.html, 'document.html', ['--standalone', '--css', 'document.css', '--toc', '--toc-depth=2'], metadata);
	writeFileSync(join(WORK, 'default-reference.docx'), docker(PANDOC_IMAGE, ['--print-default-data-file', 'reference.docx']));
	docker(PANDOC_IMAGE, ['lua', 'docx-reference.lua', 'default-reference.docx', 'reference.docx']);
	pandoc(
		sources.docx,
		'document.docx',
		// The PNG diagrams carry no resolution: --dpi gives their intended size, PNG_SCALE times the CSS pixel.
		['--reference-doc', 'reference.docx', '--lua-filter', 'docx.lua', `--dpi=${96 * PNG_SCALE}`],
		metadata
	);

	const pdf = join(OUT, `${NAME}.pdf`);
	const docx = join(OUT, `${NAME}.docx`);
	await printPdf(join(WORK, 'document.html'), pdf);
	copyFileSync(join(WORK, 'document.docx'), docx);
	for (const file of [pdf, docx]) {
		console.log(`${file.slice(ROOT.length)}  ${Math.round(statSync(file).size / 1024)} KiB`);
	}
}

await main();
