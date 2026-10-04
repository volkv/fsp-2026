<script lang="ts">
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';

	/**
	 * Uploading a resume. A file over the limit is refused here, before it travels; the server checks the size and the
	 * content again and names the problem in the same words.
	 */
	let {
		problem,
		uploaded,
		hasCurrent
	}: { problem: { message: string } | null; uploaded: boolean; hasCurrent: boolean } = $props();

	/** The parser limit (docs/contracts.md, section 4.3). */
	const MAX_BYTES = 10 * 1024 * 1024;
	const TOO_LARGE = 'Файл больше 10 МиБ: загрузите файл меньшего размера';
	const ACCEPT = '.pdf,.docx,.doc,.rtf,.odt,.txt,.png,.jpg,.jpeg';

	let files = $state<FileList | undefined>();
	let pending = $state(false);
	const tooLarge = $derived(oversized(files?.[0]));
	const id = $props.id();
	const error = $derived(tooLarge ? TOO_LARGE : (problem?.message ?? null));

	function oversized(file: unknown): boolean {
		return file instanceof File && file.size > MAX_BYTES;
	}
</script>

<form
	method="POST"
	action="?/upload"
	enctype="multipart/form-data"
	class="grid gap-3"
	data-testid="resume-upload"
	use:enhance={({ formData, cancel }) => {
		if (oversized(formData.get('file'))) {
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
	<div class="grid gap-1.5 text-sm">
		<label for="{id}-file" class="font-medium">Файл резюме</label>
		<Input
			id="{id}-file"
			type="file"
			name="file"
			accept={ACCEPT}
			required
			aria-describedby="{id}-hint"
			aria-invalid={error ? 'true' : undefined}
			bind:files
		/>
		<p id="{id}-hint" class="text-muted-foreground">
			PDF или DOCX до 10 МиБ; подойдут и DOC, RTF, ODT, TXT и скан в PNG или JPEG.
			{#if hasCurrent}Новый файл заменит текущее резюме: поля извлекутся заново.{/if}
		</p>
	</div>
	<Button type="submit" class="w-fit" disabled={pending}>
		<UploadIcon aria-hidden="true" />
		{pending ? 'Загружаем…' : 'Загрузить резюме'}
	</Button>
</form>
