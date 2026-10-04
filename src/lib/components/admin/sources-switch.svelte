<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';

	/**
	 * The switch of one vacancy source. Flipping it asks for confirmation; enabling puts an out-of-turn full import in the
	 * queue, disabling stops the schedule and the freshness checks of the source. Both are written to the action journal.
	 */
	let {
		source,
		name,
		enabled,
		attribution,
		storeDescription
	}: {
		source: string;
		name: string;
		enabled: boolean;
		/** What every card of the source shows. */
		attribution: string;
		/** The terms allow storing the description of a posting. */
		storeDescription: boolean;
	} = $props();

	let open = $state(false);
	let pending = $state(false);
	const next = $derived(!enabled);
	const formId = $derived(`source-form-${source}`);
	const labelId = $derived(`source-label-${source}`);
</script>

<form
	id={formId}
	method="POST"
	action="?/switchSource"
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
	<input type="hidden" name="source" value={source} />
	<input type="hidden" name="enabled" value={String(next)} />
	<Switch
		id="source-switch-{source}"
		aria-labelledby={labelId}
		disabled={pending}
		bind:checked={
			() => enabled,
			() => {
				open = true;
			}
		}
	/>
	<span id={labelId} class="sr-only">{name}</span>
	<span class="text-sm font-medium" aria-hidden="true">{enabled ? 'Вкл' : 'Выкл'}</span>
</form>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{next ? 'Включить' : 'Выключить'} «{name}»?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if next}
					Сразу встанет в очередь полный импорт, дальше источник импортируется по своему расписанию. Условия источника
					требуют подписи «{attribution}» и ссылки на публикацию{storeDescription
						? ''
						: '; описания вакансий не хранятся'}.
				{:else}
					Импорт по расписанию и проверки актуальности остановятся; уже загруженные вакансии источника останутся, но их
					актуальность больше не проверяется. Импорт, который идёт сейчас, не запишет результат.
				{/if}
				Переключение будет записано в журнал действий.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Отмена</AlertDialog.Cancel>
			<Button type="submit" form={formId} variant={next ? 'default' : 'destructive'} disabled={pending}>
				{next ? 'Включить' : 'Выключить'}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
