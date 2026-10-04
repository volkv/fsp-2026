<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { verdictOf, type TestView } from './model.js';

	/**
	 * Verdicts of a run. Open tests show their input, the expected output and the start of the program output; hidden
	 * tests show only the verdict — their data never leaves the server.
	 */
	let { tests }: { tests: TestView[] } = $props();

	const open = $derived(tests.filter((test) => !test.hidden));
	const hidden = $derived(tests.filter((test) => test.hidden));
	const hiddenPassed = $derived(hidden.filter((test) => test.verdict === 'accepted').length);

	const toneClass = { success: 'text-success', error: 'text-destructive', muted: 'text-muted-foreground' };
</script>

<div class="grid gap-4" data-testid="verdicts">
	<ul class="grid gap-3">
		{#each open as test (test.id)}
			{@const verdict = verdictOf(test.verdict)}
			<li class="grid gap-2 rounded-lg border p-3 text-sm" data-testid="open-test" data-verdict={test.verdict}>
				<div class="flex flex-wrap items-center justify-between gap-2">
					<span class="font-medium">Открытый тест {test.id}</span>
					<span class={cn('font-medium', toneClass[verdict.tone])}>{verdict.label}</span>
				</div>
				<p class="text-xs text-muted-foreground">
					{test.skipped
						? 'Не запускался: закончилось общее время проверки'
						: `${test.cpuTimeMs} мс · ${Math.round(test.memoryKb / 1024)} МБ`}
				</p>
				<div class="grid gap-2 md:grid-cols-3">
					{#each [['Вход', test.stdin], ['Ожидалось', test.expected], ['Твой вывод (начало)', test.stdoutPreview]] as [label, text] (label)}
						<div class="grid min-w-0 content-start gap-1">
							<span class="text-xs text-muted-foreground">{label}</span>
							<pre class="rounded bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{text ?? '—'}</pre>
						</div>
					{/each}
				</div>
			</li>
		{/each}
	</ul>
	{#if hidden.length > 0}
		<div class="grid gap-2 rounded-lg border p-3 text-sm" data-testid="hidden-tests">
			<p>
				<span class="font-medium">Скрытые тесты: пройдено {hiddenPassed} из {hidden.length}.</span>
				<span class="text-muted-foreground">Их входные данные и ожидаемый вывод не показываются.</span>
			</p>
			<ul class="flex flex-wrap gap-1.5">
				{#each hidden as test, index (test.id)}
					{@const verdict = verdictOf(test.verdict)}
					<li class={cn('rounded-full border px-2 py-0.5 text-xs', toneClass[verdict.tone])}>
						№ {index + 1}: {verdict.label}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
