/**
 * Wording and view models of platform tests in the candidate cabinet (on «ты»). The honest note is the product promise
 * in one place: an attempt confirms one task in fixed conditions, not independent work or the whole qualification, and
 * the platform claims no detection of generated code.
 */

/** The honest note of each kind of test: a quiz runs no code, so its note names no sandbox. */
export const HONEST_NOTES: Record<'code_task' | 'quiz', string> = {
	code_task:
		'Успешная попытка подтверждает одно: решение прошло тесты этого задания в изолированной песочнице с его лимитами. Это не доказательство самостоятельного выполнения и не оценка всей квалификации. Обнаружение кода, написанного с помощью ИИ, мы не заявляем.',
	quiz: 'Засчитанный квиз подтверждает одно: ответы на вопросы этой версии квиза дали указанный уровень с указанной уверенностью. Это не экзамен, не доказательство самостоятельных ответов и не оценка всей квалификации; уровень подтверждает или ограничивает сверху грейд по опыту работы, но не поднимает его. Обнаружение подсказок ИИ мы не заявляем.'
};

export const QUIZ_NOTE =
	'Квиз проверяет знание языка вопросами разной сложности и подбирает следующий вопрос по твоим ответам.';

export const SIGNALS_NOTE =
	'Во время попытки платформа записывает время ответа, вставки из буфера и уходы со страницы. Эти сигналы видит только оператор ФСП, если попытку пересматривают. Они ничего не решают автоматически и не являются детекцией ИИ.';

export type AssessmentLevel = 'junior' | 'middle' | 'senior';

export const LEVELS: Record<string, string> = {
	junior: 'Junior',
	middle: 'Middle',
	senior: 'Senior',
	not_passed: 'Не пройдено',
	not_confirmed: 'Уровень не подтверждён'
};

export const levelName = (level: string) => LEVELS[level] ?? level;

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

export const VERDICTS: Record<string, { label: string; tone: 'success' | 'error' | 'muted' }> = {
	accepted: { label: 'Принято', tone: 'success' },
	wrong_answer: { label: 'Неверный ответ', tone: 'error' },
	time_limit: { label: 'Превышено время', tone: 'error' },
	memory_limit: { label: 'Превышена память', tone: 'error' },
	output_limit: { label: 'Слишком большой вывод', tone: 'error' },
	runtime_error: { label: 'Ошибка выполнения', tone: 'error' },
	compile_error: { label: 'Ошибка компиляции', tone: 'error' },
	sandbox_error: { label: 'Сбой песочницы', tone: 'muted' }
};

export const verdictOf = (verdict: string) => VERDICTS[verdict] ?? { label: verdict, tone: 'muted' as const };

export const ATTEMPT_STATUSES: Record<string, string> = {
	started: 'Идёт',
	submitted: 'На проверке',
	scored: 'Оценена',
	expired: 'Время истекло',
	annulled: 'Аннулирована'
};

export const RUN_STATES: Record<string, string> = {
	queued: 'Решение в очереди на проверку',
	running: 'Решение проверяется в песочнице',
	done: 'Проверка завершена',
	failed: 'Песочница не смогла проверить решение. Попытка не засчитана против тебя: оператор ФСП разберёт её.',
	none: 'Решение не отправлено'
};

export const REFUSALS: Record<string, string> = {
	attempt_active: 'У тебя уже есть незавершённая попытка этого задания.',
	attempts_exhausted: 'Попытки этого задания закончились.',
	retake_interval: 'Нужно подождать до следующей попытки.'
};

// --- View models (the shapes the server loads give the page) ------------------------------------------------------

export interface CoverageView {
	skills: { skillKey: string; levels: string[]; languages?: string[] }[];
	checks: string[];
	doesNotCheck: string[];
	notes?: string[];
}

export interface ScoreView {
	score: number;
	maxScore: number;
	level: string;
	confirmed: boolean;
	scoredAt: Date;
	details: Record<string, unknown>;
	fact: { id: string; status: string; skillKeys: string[] } | null;
}

export interface AllowanceView {
	used: number;
	max: number;
	activeAttemptId: string | null;
	nextAt: Date | null;
	blocked: 'attempt_active' | 'attempts_exhausted' | 'retake_interval' | null;
}

export interface CatalogEntryView {
	assessmentId: string;
	kind: 'code_task' | 'quiz';
	title: string;
	summary: string;
	level: string | null;
	skillKeys: string[];
	languages: string[];
	timeLimitMinutes: number;
	maxQuestions: number | null;
	coverage: CoverageView;
	allowance: AllowanceView;
	best: ScoreView | null;
}

export type Inline = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string };

export type StatementBlock =
	| { kind: 'heading'; text: string }
	| { kind: 'paragraph'; inlines: Inline[] }
	| { kind: 'code'; text: string }
	| { kind: 'list'; ordered: boolean; items: Inline[][] };

export interface TestView {
	id: string;
	hidden: boolean;
	verdict: string;
	skipped: boolean;
	cpuTimeMs: number;
	memoryKb: number;
	stdin: string | null;
	expected: string | null;
	stdoutPreview: string | null;
}

export interface SignalEntryView {
	at: string;
	stage: 'code_submission' | 'quiz_step';
	itemId?: string;
	responseMs?: number;
	client: { elapsedMs: number; pasteCount: number; pastedChars: number; blurCount: number } | null;
}

/** Confidence of a quiz level stored with its score, if any. */
export function confidenceOf(score: ScoreView): number | null {
	const value = score.details.confidence;
	return typeof value === 'number' ? value : null;
}

export const percent = (value: number) => `${Math.round(value * 100)}%`;
