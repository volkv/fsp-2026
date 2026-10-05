/**
 * Wording of the test on a declared grade in the cabinets (to the candidate — on «ты»). The honest note is the product
 * promise in one place: a confirmed grade means the items of this test were done in its conditions — without
 * supervision, with limits and a journal of signals — not independent work and not the whole qualification; the
 * platform claims no detection of generated code.
 */

export const HONEST_NOTE =
	'Подтверждённый грейд значит одно: задания этого теста выполнены в его условиях — без надзора, с лимитами и журналом сигналов. Это не доказательство самостоятельного выполнения и не оценка всей квалификации. Обнаружение кода, написанного с помощью ИИ, мы не заявляем.';

export const HOW_IT_DECIDES =
	'Задания подаются по одному. После каждого ответа последовательная проверка сравнивает твои баллы с оценками пограничного кандидата грейда по тем же заданиям: тест заканчивается, как только решение уверенно, — не раньше шестого задания и не позже восемнадцатого. Если баллы остаются в полосе неопределённости, тест продлевается один раз; после продления возможен итог «не определено» — это не провал.';

export const SIGNALS_NOTE =
	'Во время попытки платформа записывает время ответа, вставки из буфера и уходы со страницы. Эти сигналы видят оператор ФСП при пересмотре и работодатель рядом с результатом. Они ничего не решают автоматически и не являются детекцией ИИ.';

export const LANGUAGES: Record<string, string> = {
	python3: 'Python 3',
	javascript: 'JavaScript (Node.js)',
	typescript: 'TypeScript (Node.js, стираемый синтаксис)',
	go: 'Go',
	cpp17: 'C++17',
	java21: 'Java 21'
};

export const languageName = (key: string) => LANGUAGES[key] ?? key;

/** A minimal program that reads the whole input, per language: the starting point of the editor. */
export const STARTERS: Record<string, string> = {
	python3: 'import sys\n\n\ndef main() -> None:\n    data = sys.stdin.read()\n    print(data)\n\n\nmain()\n',
	javascript: "const input = require('node:fs').readFileSync(0, 'utf8');\n\nconsole.log(input);\n",
	typescript:
		"import { readFileSync } from 'node:fs';\n\nconst input: string = readFileSync(0, 'utf8');\n\nconsole.log(input);\n",
	go: 'package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tin := bufio.NewReader(os.Stdin)\n\tout := bufio.NewWriter(os.Stdout)\n\tdefer out.Flush()\n\n\tvar n int\n\tfmt.Fscan(in, &n)\n\tfmt.Fprintln(out, n)\n}\n',
	cpp17:
		'#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    return 0;\n}\n',
	java21:
		'import java.io.BufferedReader;\nimport java.io.IOException;\nimport java.io.InputStreamReader;\n\npublic class Main {\n\tpublic static void main(String[] args) throws IOException {\n\t\tBufferedReader in = new BufferedReader(new InputStreamReader(System.in));\n\t\tSystem.out.println(in.readLine());\n\t}\n}\n'
};

export const ATTEMPT_STATUSES: Record<
	string,
	{ label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
> = {
	in_progress: { label: 'Идёт', tone: 'info' },
	decided: { label: 'Решение принято', tone: 'neutral' },
	expired: { label: 'Время истекло', tone: 'warning' },
	annulled: { label: 'Аннулирована', tone: 'danger' }
};

export const OUTCOMES: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
	confirmed: { label: 'Подтверждено', tone: 'success' },
	not_confirmed: { label: 'Не подтверждено', tone: 'danger' },
	undetermined: { label: 'Не определено', tone: 'warning' }
};

/** Why a test cannot start now (`BlockReason` of the grade policy), in the candidate's words. */
export const BLOCK_REASONS: Record<string, string> = {
	attempt_in_progress: 'Сначала закончи идущую попытку.',
	not_declared: 'Сначала заяви грейд в этой специализации.',
	above_declared: 'Выше заявленного грейда — сначала новое заявление.',
	lower_requires_failure: 'Грейд ниже открывается после неудачи на грейде выше.',
	below_confirmed: 'Ниже подтверждённого грейда тест не нужен.',
	already_confirmed: 'Этот грейд уже подтверждён.',
	above_next_grade: 'Тестируется только следующий грейд после подтверждённого.',
	grade_change_interval: 'Подтверждённый грейд меняется не чаще раза в 90 дней.',
	retake_interval: 'Повтор — через 14 дней после неудачи, на другой форме.',
	attempt_limit: 'Не больше двух попыток на грейд за 180 дней.'
};

export const OPTION_KINDS: Record<string, string> = {
	declared: 'Заявленный грейд',
	lower_after_failure: 'Грейд ниже после неудачи',
	upgrade_confident: 'Следующий грейд по уверенному результату',
	upgrade_interval: 'Следующий грейд'
};

/** Why an attempt was annulled, in the candidate's words. */
export const ANNUL_REASONS: Record<string, string> = {
	plagiarism: 'Оператор ФСП установил по ответам и коду, что задания выполнены не самостоятельно.',
	candidate_request: 'Результат снят по твоей просьбе.',
	technical_failure: 'Попытка сорвалась из-за технического сбоя на стороне платформы.',
	version_defect: 'В задании этой версии банка нашлась ошибка.',
	objection_upheld: 'Возражение против результата удовлетворено.'
};

export const STAGE_NAMES: Record<string, string> = {
	answer: 'ответ',
	submission: 'отправка решения',
	change_step: 'шаг «измени своё решение»'
};

export interface SignalEntryView {
	at: string;
	stage: 'answer' | 'submission' | 'change_step';
	seq: number;
	responseMs?: number;
	client: { elapsedMs: number; pasteCount: number; pastedChars: number; blurCount: number } | null;
}

export const share = (value: number) => `${Math.round(value * 100)}%`;
export const points = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

export type Inline = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string };

/** A block of a statement, parsed on the server: the page renders elements only, never HTML from the bank. */
export type StatementBlock =
	| { kind: 'heading'; text: string }
	| { kind: 'paragraph'; inlines: Inline[] }
	| { kind: 'code'; text: string }
	| { kind: 'list'; ordered: boolean; items: Inline[][] };
