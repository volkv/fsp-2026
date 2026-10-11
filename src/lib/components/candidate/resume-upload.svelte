<script lang="ts">
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { cn } from '$lib/components/utils.js';

	/**
	 * Uploading a resume: a file dropped on the zone or picked by a click is sent at once. A file over the limit is refused
	 * here, before it travels; the server checks the size and the content again and names the problem in the same words.
	 */
	let {
		problem,
		uploaded,
		hasCurrent,
		consent
	}: {
		problem: { message: string } | null;
		uploaded: boolean;
		hasCurrent: boolean;
		/** The separate consent a demo session asks before the first upload of one's own resume; `null` — not asked. */
		consent: { id: string; title: string; version: number; body: string; hours: number | null } | null;
	} = $props();

	/** The parser limit (docs/contracts.md, section 4.3). */
	const MAX_BYTES = 10 * 1024 * 1024;
	const TOO_LARGE = 'Файл больше 10 МиБ: загрузите файл меньшего размера';
	const ACCEPT = '.pdf,.docx,.doc,.rtf,.odt,.txt,.png,.jpg,.jpeg';

	let form = $state<HTMLFormElement | null>(null);
	let input = $state<HTMLInputElement | null>(null);
	let tooLarge = $state(false);
	let pending = $state(false);
	let dragging = $state(false);
	let agreed = $state(false);
	const locked = $derived(consent !== null && !agreed);
	const id = $props.id();
	const error = $derived(tooLarge ? TOO_LARGE : (problem?.message ?? null));

	function oversized(file: unknown): boolean {
		return file instanceof File && file.size > MAX_BYTES;
	}

	function send() {
		if (!input?.files?.length || pending || locked) return;
		form?.requestSubmit();
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const files = event.dataTransfer?.files;
		if (!input || pending || locked || !files?.length) return;
		input.files = files;
		send();
	}
</script>

<form
	bind:this={form}
	method="POST"
	action="?/upload"
	enctype="multipart/form-data"
	class="grid gap-3"
	data-testid="resume-upload"
	use:enhance={({ formData, cancel }) => {
		tooLarge = oversized(formData.get('file'));
		if (tooLarge) {
			cancel();
			return;
		}
		pending = true;
		return async ({ update }) => {
			await update();
			pending = false;
		};
	}}
>
	<CsrfInput />
	{#if error}
		<FormMessage text={error} />
	{:else if uploaded}
		<FormMessage tone="success" text="Резюме загружено. Читаем его — поля появятся здесь через минуту." />
	{/if}
	{#if consent}
		<div class="grid gap-2 rounded-xl border bg-card p-4 text-sm" data-testid="own-resume-consent">
			<input type="hidden" name="document" value={consent.id} />
			<label class="flex items-start gap-3">
				<input
					type="checkbox"
					name="agree"
					class="mt-0.5 size-4 accent-primary"
					bind:checked={agreed}
					disabled={pending}
				/>
				<span>
					Даю {consent.title.toLowerCase()} (редакция {consent.version}).
					{#if consent.hours !== null}Резюме и всё, что из него получено, удалится через {consent.hours} ч после загрузки.{/if}
				</span>
			</label>
			<details class="text-muted-foreground">
				<summary class="cursor-pointer">Текст согласия</summary>
				<p class="mt-2 whitespace-pre-line" data-testid="document-body">{consent.body}</p>
			</details>
		</div>
	{/if}
	<label
		for="{id}-file"
		class={cn(
			'flex min-h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-card p-6 text-center transition-colors focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring/50 hover:border-primary/60',
			dragging && 'border-primary bg-primary/5',
			pending && 'pointer-events-none cursor-default',
			locked && 'cursor-not-allowed opacity-50 hover:border-border'
		)}
		aria-busy={pending}
		aria-disabled={locked || undefined}
		ondragenter={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragover={(event) => {
			event.preventDefault();
		}}
		ondragleave={(event) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragging = false;
		}}
		ondrop={drop}
	>
		<input
			bind:this={input}
			id="{id}-file"
			type="file"
			name="file"
			accept={ACCEPT}
			required
			class="sr-only"
			aria-label="Файл резюме"
			aria-describedby="{id}-hint"
			aria-invalid={error ? 'true' : undefined}
			disabled={pending || locked}
			onchange={send}
		/>
		{#if pending}
			<Spinner aria-hidden="true" role="presentation" class="size-8 text-primary" />
			<span class="font-medium" role="status">Загружаем…</span>
		{:else}
			<FileUpIcon aria-hidden="true" class="size-8 text-primary" />
			<span class="font-medium">{hasCurrent ? 'Загрузить новую версию' : 'Загрузить резюме'}</span>
			<span id="{id}-hint" class="text-sm text-muted-foreground">
				{locked ? 'Сначала отметьте согласие выше' : 'Перетащите файл сюда или нажмите. PDF, DOCX или скан, до 10 МиБ'}
			</span>
		{/if}
	</label>
</form>
