<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';

	/**
	 * The run-time switch of one model operation. Flipping it asks for confirmation; the change takes effect in every
	 * process within seconds, without a restart, and is written to the action journal.
	 */
	let {
		operation,
		title,
		mode,
		configured,
		fallback
	}: {
		operation: string;
		title: string;
		/** `null` — the mode store is not readable: nothing to switch from. */
		mode: 'on' | 'off' | null;
		configured: boolean;
		/** What the product does without the model. */
		fallback: string;
	} = $props();

	let open = $state(false);
	let pending = $state(false);
	const next = $derived(mode === 'on' ? 'off' : 'on');
	const formId = $derived(`mode-form-${operation}`);
	const labelId = $derived(`mode-label-${operation}`);
</script>

<form
	id={formId}
	method="POST"
	action="?/switchMode"
	class="flex items-center gap-3"
	use:enhance={() => {
		pending = true;
		return async ({ update }) => {
			await update();
			pending = false;
			open = false;
		};
	}}
>
	<CsrfInput />
	<input type="hidden" name="operation" value={operation} />
	<input type="hidden" name="mode" value={next} />
	<Switch
		id="mode-switch-{operation}"
		aria-labelledby={labelId}
		disabled={mode === null || pending}
		bind:checked={
			() => mode === 'on',
			() => {
				open = true;
			}
		}
		data-operation={operation}
	/>
	<span id={labelId} class="sr-only">{title}</span>
	<span class="text-sm font-medium" aria-hidden="true">{mode === 'on' ? 'Вкл' : mode === 'off' ? 'Выкл' : '—'}</span>
</form>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{next === 'off' ? 'Выключить' : 'Включить'} «{title}»?
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if next === 'off'}
					Все процессы перестанут обращаться к модели в течение нескольких секунд, без перезапуска. {fallback}
				{:else if configured}
					Процессы снова начнут обращаться к модели в течение нескольких секунд.
				{:else}
					Операция не настроена в окружении: включение снимет запрет, но путь без модели останется, пока рантайм не
					задан.
				{/if}
				Переключение будет записано в журнал действий.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Отмена</AlertDialog.Cancel>
			<Button type="submit" form={formId} variant={next === 'off' ? 'destructive' : 'default'} disabled={pending}>
				{next === 'off' ? 'Выключить' : 'Включить'}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
