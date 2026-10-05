// The review pack of families for an independent reviewer (docs/domain.md, 10.2 and 10.8): for every family, a
// Markdown file with what a review and a blind Angoff rating need — the block and the definitions of the grades, the
// levels and classes, the rubric, what the family checks and does not, its wrong solutions, and instances of every
// class on a few seeds with their reference (expected answer, reference program, defect fix, hidden tests) — and a
// review template in JSON to fill and give to `record-review.ts`. The ratings already made are not in the pack: the
// round is blind.
//
//   node scripts/assessments/review-pack.ts --out <dir> [--family <key prefix> …] [--seeds <n>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Built, ReferenceProbe } from '../../assessments/families/_lib/family.ts';
import type { FamilyDescriptor, ItemInstance } from '../../src/lib/server/assessments/contract/bank.ts';
import { CATALOG, gradeDefinition } from '../../src/lib/server/assessments/contract/catalog.ts';
import { currentSourceSha256, GENERATOR_FILE, loadTree, type TreeFamily } from './tree.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TEST_PREVIEW = 600;

const fence = (text: string, language = ''): string => {
	const ticks = text.includes('```') ? '````' : '```';
	return `${ticks}${language}\n${text}\n${ticks}`;
};
const clip = (text: string, limit: number): string =>
	text.length <= limit ? text : `${text.slice(0, limit)}\n… (ещё ${text.length - limit} символов)`;

function referenceSection(probe: ReferenceProbe, instance: ItemInstance): string[] {
	switch (probe.kind) {
		case 'output':
			return [
				'**Эталон.** Программа, которой ворота подтверждают ответ (её вывод совпал с ответом генератора на 200 сидах каждого класса):',
				'',
				fence(probe.source, 'python'),
				...(probe.stdin ? ['', 'Вход эталона:', '', fence(clip(probe.stdin, TEST_PREVIEW))] : [])
			];
		case 'bug':
			return [
				`**Эталон.** Строка ${instance.answer?.kind === 'line_no' ? instance.answer.value : '?'} заменяется на`,
				'',
				fence(probe.fix, 'python'),
				'',
				'и тогда проходят проверки спецификации (с дефектом — не проходят):',
				'',
				fence(probe.check, 'python')
			];
		case 'practice':
			return [
				'**Эталонная программа:**',
				'',
				fence(probe.source, 'python'),
				...(probe.changeSource
					? ['', '**Эталон после шага «измени своё решение»:**', '', fence(probe.changeSource, 'python')]
					: [])
			];
		case 'qa':
			return [
				'**Кейсы автора** (проходят на эталоне и убивают всех неэквивалентных мутантов):',
				'',
				fence(JSON.stringify(probe.cases, null, 1), 'json'),
				'',
				'**Обвязка с эталоном и мутантами** (кандидату не показывается):',
				'',
				fence(probe.harness.mutants, 'python')
			];
	}
}

function instanceSection(built: Built): string[] {
	const instance = built.instance;
	const lines = [
		instance.statement.markdown,
		...(instance.statement.code ? ['', fence(instance.statement.code.source, instance.statement.code.language)] : [])
	];
	if (instance.answer)
		lines.push(
			'',
			`**Ожидаемый ответ** (\`${instance.answer.kind}\`):`,
			'',
			fence(JSON.stringify(instance.answer.value, null, 1))
		);
	if (instance.practice) {
		lines.push('', '**Группы скрытых тестов** (первый тест группы; остальные — того же аспекта):', '');
		for (const group of instance.practice.groups) {
			const first = group.tests[0];
			lines.push(
				`- \`${group.id}\` — ${group.tests.length} тест(ов); вход:`,
				'',
				fence(clip(first?.stdin ?? '', TEST_PREVIEW)),
				'',
				'  ожидаемый вывод:',
				'',
				fence(clip(first?.expected ?? '', TEST_PREVIEW))
			);
		}
	}
	if (instance.qa) lines.push('', '**Спецификация для кандидата:**', '', instance.qa.specification);
	if (instance.changeStep) lines.push('', '**Шаг «измени своё решение»:**', '', instance.changeStep.markdown);
	lines.push('', ...referenceSection(built.reference(), instance));
	return lines;
}

function familyPack(family: TreeFamily, built: Map<string, Built[]>, seeds: number): string {
	const d: FamilyDescriptor = family.descriptor;
	const block = CATALOG.blocks.find((b) => b.code === d.block);
	const out: string[] = [
		`# Ревью семейства \`${d.key}\``,
		'',
		`Исходники ревью: \`sourceSha256 = ${currentSourceSha256(family)}\` — впишите его в файл ревью без изменений.`,
		`Генератор: \`${relative(REPO, join(family.dir, GENERATOR_FILE))}\`. Специализация ${d.specialization}, формат \`${d.format}\`, ответ \`${d.answerKind}\`${d.language ? `, код на \`${d.language}\`` : ''}.`,
		'',
		'## Что от вас нужно',
		'',
		'1. **Рубрика и эталон.** Проверьте, что условие однозначно и полно, ответ (или скрытые тесты) следует из условия и только из него,',
		'   эталон верен, задание не решается угадыванием, ошибочные решения действительно ошибочны и отвергаются, классы — разные пути решения.',
		'   Вердикт `approved` или `changes_requested`, замечания — по одному на пункт.',
		'2. **Angoff, слепо.** Для каждого уровня — вероятность (шаг 0,05), что **пограничный** кандидат этого грейда (определение ниже)',
		'   решит кластер этого семейства. Чужих оценок в пакете нет.',
		'',
		`## Блок \`${d.block}\` — ${block?.title ?? ''}`,
		'',
		block?.checks ?? '',
		''
	];
	for (const level of d.levels) {
		const definition = gradeDefinition(d.specialization, level.grade);
		out.push(
			`## Уровень ${level.grade}`,
			'',
			`**Пограничный кандидат:** ${definition.borderline}`,
			'',
			'**Ожидается:**',
			'',
			...definition.expects.map((e) => `- ${e}`),
			'',
			`Норма времени — ${level.timeNormSec} с. Параметры сложности: \`${JSON.stringify(level.constructive)}\`.`,
			'',
			'Классы существенных параметров:',
			'',
			...level.classes.map((c) => `- \`${c.id}\` (форма ${c.form}) — ${c.description}`),
			''
		);
	}
	out.push(
		'## Параметры, рубрика, покрытие, ошибочные решения',
		'',
		'Существенные параметры:',
		'',
		...d.essentialParams.map((p) => `- \`${p.name}\` — ${p.description}`),
		'',
		'Поверхностные параметры:',
		'',
		...d.surfaceParams.map((p) => `- \`${p.name}\` — ${p.description}`),
		'',
		`Рубрика: \`${JSON.stringify(d.rubric)}\`${d.changeStep ? `; шаг «измени своё решение» (вес ${d.changeStep.weight}): ${d.changeStep.description}` : ''}.`,
		'',
		'Проверяет:',
		'',
		...d.coverage.checks.map((c) => `- ${c}`),
		'',
		'Не проверяет:',
		'',
		...d.coverage.doesNotCheck.map((c) => `- ${c}`),
		'',
		'Ошибочные решения (ворота отвергают каждое на всех экземплярах, к которым оно применимо):',
		'',
		...d.wrongSolutions.map((w) => `- \`${w.id}\` — ${w.defect}`),
		'',
		`Отчёт ворот: \`${JSON.stringify({ ...d.gates, rubricReviews: undefined })}\`.`,
		''
	);
	for (const level of d.levels) {
		for (const cls of level.classes) {
			const builds = built.get(`${level.grade}/${cls.id}`) ?? [];
			builds.forEach((b, i) => {
				out.push(
					`## Экземпляр: ${level.grade}, класс \`${cls.id}\` (${cls.form}), сид ${i + 1} из ${seeds}`,
					'',
					...instanceSection(b),
					''
				);
			});
		}
	}
	return `${out.join('\n')}\n`;
}

function template(family: TreeFamily): object {
	return {
		family: family.key,
		sourceSha256: currentSourceSha256(family),
		reviewer: { kind: 'model', model: '<модель>', lineage: '<линейка поставщика>' },
		reviewedAt: '<ГГГГ-ММ-ДД>',
		verdict: '<approved | changes_requested>',
		remarks: [],
		angoff: family.descriptor.levels.map((level) => ({ grade: level.grade, p: '<0,05–0,95, шаг 0,05>' }))
	};
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { out: { type: 'string' }, family: { type: 'string', multiple: true }, seeds: { type: 'string' } }
	});
	if (!values.out) throw new Error('usage: review-pack.ts --out <dir> [--family <key prefix> …] [--seeds <n>]');
	const seeds = values.seeds === undefined ? 2 : Number.parseInt(values.seeds, 10);
	if (!Number.isInteger(seeds) || seeds < 1)
		throw new Error(`--seeds must be a positive integer, got ${String(values.seeds)}`);
	const { families, problems } = loadTree();
	if (problems.length > 0) throw new Error(problems.join('\n'));
	const prefixes = values.family ?? [];
	const selected = families.filter((f) => prefixes.length === 0 || prefixes.some((p) => f.key.startsWith(p)));
	if (selected.length === 0) throw new Error(`no family matches ${prefixes.join(', ')}`);
	mkdirSync(values.out, { recursive: true });
	for (const family of selected) {
		const module = await family.module();
		const built = new Map<string, Built[]>();
		for (const level of family.descriptor.levels) {
			for (const cls of level.classes) {
				built.set(
					`${level.grade}/${cls.id}`,
					Array.from({ length: seeds }, (_, i) =>
						module.build({ seed: `review|${family.key}|${i}`, grade: level.grade, classId: cls.id })
					)
				);
			}
		}
		writeFileSync(join(values.out, `${family.key}.md`), familyPack(family, built, seeds));
		writeFileSync(join(values.out, `${family.key}.review.json`), `${JSON.stringify(template(family), null, '\t')}\n`);
	}
	console.log(`${selected.length} families packed into ${values.out}`);
}

await main();
