<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import CodeEditor from './code-editor.svelte';
	import { languageName, STARTERS } from './model.js';
	import type { AttemptSignals } from './signals.svelte.js';

	/**
	 * The answer to the current cluster: a computed value (a list — one item per line), a program in a language of the
	 * practice, QA test cases within the budget, or the step «измени своё решение». The page's signals go with the form.
	 */
	let {
		seq,
		answerKind,
		languages,
		qa,
		step,
		signals
	}: {
		seq: number;
		answerKind: string;
		languages: readonly string[];
		qa: { budget: { min: number; max: number } } | null;
		/** The open step «измени своё решение»; `null` — the task itself is answered. */
		step: { kind: 'code' | 'cases' } | null;
		signals: AttemptSignals;
	} = $props();

	const mode = $derived(
		step ? (step.kind === 'code' ? 'step_code' : 'step_cases') : languages.length > 0 ? 'code' : qa ? 'cases' : 'answer'
	);
	const listAnswer = $derived(!step && (answerKind === 'set' || answerKind === 'sequence'));

	let language = $state('');
	let source = $state('');
	let answer = $state('');
	let pending = $state(false);
	const chosen = $derived(language || languages[0] || '');

	$effect(() => {
		// A new language starts from its template unless the candidate has written something of their own.
		if (chosen && (source === '' || Object.values(STARTERS).includes(source))) source = STARTERS[chosen] ?? '';
	});

	$effect(() => signals.watchPage());

	const rows = $derived(qa ? Array.from({ length: qa.budget.max }, (_, i) => i) : []);
	const fieldId = $props.id();
</script>

<form
	method="POST"
	action="?/answer"
	class="grid gap-3"
	data-testid="answer-form"
	data-mode={mode}
	use:enhance={({ formData }) => {
		pending = true;
		formData.set('signals', signals.serialize());
		return async ({ update }) => {
			await update();
			pending = false;
			signals.reset();
			answer = '';
		};
	}}
>
	<CsrfInput />
	<input type="hidden" name="seq" value={seq} />
	<input type="hidden" name="mode" value={mode} />

	{#if mode === 'code' || mode === 'step_code'}
		<div class="flex flex-wrap items-center gap-2">
			<Label for="{fieldId}-language">Язык</Label>
			<select
				id="{fieldId}-language"
				name="language"
				value={chosen}
				onchange={(event) => {
					language = event.currentTarget.value;
				}}
				class="h-9 rounded-md border border-input bg-background px-2 text-sm"
			>
				{#each languages as key (key)}<option value={key}>{languageName(key)}</option>{/each}
			</select>
		</div>
		<CodeEditor id="{fieldId}-source" bind:value={source} {signals} />
		<p class="text-xs text-muted-foreground">
			Программа читает вход из стандартного ввода и печатает ответ. Она запускается на скрытых тестах задания; вы
			увидите, сколько групп тестов пройдено, но не их входы.
		</p>
	{:else if (mode === 'cases' || mode === 'step_cases') && qa}
		<p class="text-sm text-muted-foreground">
			Напишите от {qa.budget.min} до {qa.budget.max} тест-кейсов: вход и ожидаемый выход. Набор сначала проверяется на исправной
			программе — кейс, который она не проходит, обнуляет набор; затем — на мутантах.
		</p>
		<ol class="grid gap-2">
			{#each rows as row (row)}
				<li class="grid gap-2 sm:grid-cols-2">
					<Input
						name="case_input"
						aria-label="Вход кейса {row + 1}"
						placeholder="Вход {row + 1}"
						onpaste={(event: ClipboardEvent) => {
							signals.recordPaste(event);
						}}
					/>
					<Input name="case_expected" aria-label="Ожидаемый выход кейса {row + 1}" placeholder="Ожидается" />
				</li>
			{/each}
		</ol>
	{:else if listAnswer}
		<Label for="{fieldId}-answer">Ответ — по одному элементу в строке</Label>
		<Textarea
			id="{fieldId}-answer"
			name="answer"
			bind:value={answer}
			rows={5}
			class="font-mono"
			onpaste={(event: ClipboardEvent) => {
				signals.recordPaste(event);
			}}
		/>
	{:else if answerKind === 'line_no'}
		<Label for="{fieldId}-answer">Номер строки</Label>
		<Input
			id="{fieldId}-answer"
			name="answer"
			bind:value={answer}
			inputmode="numeric"
			pattern="[0-9]+"
			autocomplete="off"
			class="w-32 font-mono"
			aria-describedby="{fieldId}-line-hint"
			onpaste={(event: ClipboardEvent) => {
				signals.recordPaste(event);
			}}
		/>
		<p id="{fieldId}-line-hint" class="text-xs text-muted-foreground">
			Одно число — номер строки в коде задания, как он пронумерован выше (с 1).
		</p>
	{:else}
		<Label for="{fieldId}-answer">Ответ</Label>
		<Input
			id="{fieldId}-answer"
			name="answer"
			bind:value={answer}
			autocomplete="off"
			class="font-mono"
			onpaste={(event: ClipboardEvent) => {
				signals.recordPaste(event);
			}}
		/>
	{/if}
	<Button type="submit" class="w-fit" disabled={pending}>{pending ? 'Отправляем…' : 'Ответить'}</Button>
</form>
