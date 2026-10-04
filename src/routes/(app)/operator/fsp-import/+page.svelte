<script lang="ts">
	import FileSearchIcon from '@lucide/svelte/icons/file-search';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import DemoLockNotice from '$lib/components/product/demo-lock-notice.svelte';
	import { pluralize } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import BatchHistory from './batch-history.svelte';
	import BatchPreview from './batch-preview.svelte';
	import { REFUSALS } from './model.js';
	import type { PageProps } from './$types';

	type Preview = Extract<NonNullable<PageProps['form']>, { preview: unknown }>['preview'];

	let { data, form }: PageProps = $props();

	const ACCEPT = '.csv,.xlsx,.pdf,.docx,.odt,.rtf,text/csv';
	const MAX_BYTES = 10 * 1024 * 1024;
	const TOO_LARGE = 'Файл больше 10 МиБ: разделите пакет на части';

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	/** The preview the operator confirmed: kept on screen when the import is refused, so it can be confirmed again. */
	let confirmed = $state<Preview>();
	const preview = $derived(
		form && 'preview' in form
			? form.preview
			: form && form.stage === 'import' && 'problem' in form
				? (confirmed ?? null)
				: null
	);
	const imported = $derived(form && 'imported' in form ? form.imported : null);
	/** Problems by the field they concern; a profile may have several at once. */
	const fieldProblems = $derived.by(() => {
		const byField: Record<string, string[]> = {};
		for (const detail of problem?.details ?? []) {
			if (detail.path === undefined) continue;
			(byField[detail.path] ??= []).push(detail.message);
		}
		return byField;
	});
	/** A problem of the whole form: not about the file or the profile, which are told at their fields. */
	const generalProblem = $derived(
		problem && !fieldProblems.file && !fieldProblems.profile
			? (fieldProblems.allowRowIssues?.[0] ?? problem.message)
			: null
	);

	let files = $state<FileList | undefined>();
	let pending = $state<'preview' | 'import' | null>(null);
	/** A field changed after the preview: the preview no longer stands for what the form would send. */
	let changed = $state(false);
	const tooLarge = $derived(files?.[0] instanceof File && files[0].size > MAX_BYTES);
	const id = $props.id();

	const importedText = $derived.by(() => {
		if (!imported) return null;
		if (!imported.ok) return `Пакет не загружен: ${REFUSALS[imported.refused] ?? imported.refused}.`;
		const { summary } = imported;
		return (
			`Пакет «${imported.fileName}» загружен: ${summary.rows.matched} ${pluralize(summary.rows.matched, ['результат привязан', 'результата привязано', 'результатов привязано'])} ` +
			`к ${summary.athletes} ${pluralize(summary.athletes, ['кандидату', 'кандидатам', 'кандидатам'])}; ` +
			`новых фактов — ${summary.facts.inserted}, без изменений — ${summary.facts.unchanged}, снято — ${summary.facts.withdrawn + summary.facts.superseded}.`
		);
	});
</script>

<PageHeader
	title="Импорт результатов ФСП"
	description="Загрузите выгрузку результатов (CSV, XLSX) или протокол соревнования (PDF, DOCX, ODT, RTF). Сначала пакет проверяется: ничего не записывается, пока вы не подтвердите загрузку. Результаты попадают только к кандидатам, связавшим ФСП ID и давшим согласие на импорт."
/>

<div aria-live="polite" class="grid gap-2 empty:hidden">
	{#if generalProblem}
		<FormMessage text={generalProblem} />
	{:else if importedText}
		<FormMessage tone={imported?.ok ? 'success' : 'error'} text={importedText} />
	{/if}
</div>

{#if data.demoLocked}
	<DemoLockNotice
		text="Пакет результатов меняет достижения всех посетителей стенда и реальных участников: в демо проверка и загрузка пакета закрыты."
	/>
{:else}
	<form
		method="POST"
		action="?/preview"
		enctype="multipart/form-data"
		class="grid gap-6"
		data-testid="batch-form"
		onchange={(event) => {
			// Only the fields of the batch make the preview stale, not the confirmation checkbox.
			if ((event.target as HTMLInputElement).name !== 'allowRowIssues') changed = true;
		}}
		oninput={(event) => {
			if ((event.target as HTMLElement).tagName === 'TEXTAREA') changed = true;
		}}
		use:enhance={({ submitter, cancel }) => {
			if (tooLarge) {
				cancel();
				return;
			}
			pending = submitter?.getAttribute('formaction') === '?/import' ? 'import' : 'preview';
			if (pending === 'import') confirmed = preview ?? undefined;
			return async ({ result, update }) => {
				const done = result.type === 'success' && result.data?.stage === 'import';
				// The file stays selected after a preview or a refusal, so the same batch can be confirmed or fixed.
				await update({ reset: done });
				if (done) files = undefined;
				changed = false;
				pending = null;
			};
		}}
	>
		<CsrfInput />
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Пакет результатов</h2></Card.Title>
				<Card.Description>Файл и профиль сопоставления: какие колонки файла — какие поля результата.</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-5">
				<Field.Field data-invalid={tooLarge || fieldProblems.file !== undefined}>
					<Field.Label for="{id}-file">Файл пакета</Field.Label>
					<Input
						id="{id}-file"
						type="file"
						name="file"
						accept={ACCEPT}
						required
						aria-describedby="{id}-file-hint{tooLarge || fieldProblems.file ? ` ${id}-file-error` : ''}"
						aria-invalid={tooLarge || fieldProblems.file ? 'true' : undefined}
						bind:files
					/>
					<Field.Description id="{id}-file-hint">
						Выгрузка CSV или XLSX либо протокол PDF, DOCX, ODT, RTF — до 10 МиБ. Формат определяется по содержимому.
					</Field.Description>
					{#if tooLarge || fieldProblems.file}
						<Field.Error id="{id}-file-error">{tooLarge ? TOO_LARGE : fieldProblems.file?.join(' ')}</Field.Error>
					{/if}
				</Field.Field>

				<fieldset class="grid gap-3" aria-describedby="{id}-profile-hint">
					<legend class="text-sm font-medium">Профиль сопоставления (JSON)</legend>
					<p id="{id}-profile-hint" class="text-sm text-muted-foreground">
						Загрузите файл профиля или вставьте его текст — одно из двух.
					</p>
					<div class="grid gap-4 md:grid-cols-2">
						<Field.Field>
							<Field.Label for="{id}-profile-file">Файл профиля</Field.Label>
							<Input
								id="{id}-profile-file"
								type="file"
								name="profileFile"
								accept=".json,application/json"
								aria-invalid={fieldProblems.profile ? 'true' : undefined}
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="{id}-profile-text">Текст профиля</Field.Label>
							<Textarea
								id="{id}-profile-text"
								name="profileText"
								rows={4}
								spellcheck={false}
								class="font-mono text-xs"
								placeholder={'{ "name": "fsp-results-export", "columns": { … } }'}
								aria-invalid={fieldProblems.profile ? 'true' : undefined}
							/>
						</Field.Field>
					</div>
					{#if fieldProblems.profile}
						<div role="alert" class="grid gap-1 text-sm text-destructive" data-testid="profile-problems">
							{#if problem?.code === 'validation_failed' && fieldProblems.profile.length > 1}
								<p class="font-medium">{problem.message}:</p>
							{/if}
							<ul class="grid list-inside list-disc gap-0.5 font-mono text-xs">
								{#each fieldProblems.profile as message, i (i)}
									<li>{message}</li>
								{/each}
							</ul>
						</div>
					{/if}
				</fieldset>

				<label class="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						name="complete"
						class="mt-0.5 size-4 accent-primary"
						aria-describedby="{id}-complete-hint"
					/>
					<span>
						Пакет полный
						<span id="{id}-complete-hint" class="block text-muted-foreground">
							В выгрузке все результаты её соревнований: результаты, которых в ней нет, будут сняты с профилей. Протокол
							полный всегда, если прочитан целиком и без ошибок.
						</span>
					</span>
				</label>

				<Button
					type="submit"
					class="w-fit"
					variant={preview && !changed ? 'outline' : 'default'}
					disabled={pending !== null}
				>
					<FileSearchIcon aria-hidden="true" />
					{pending === 'preview' ? 'Проверяем…' : preview && !changed ? 'Проверить заново' : 'Проверить пакет'}
				</Button>
			</Card.Content>
		</Card.Root>

		{#if preview}
			<BatchPreview {preview} stale={changed}>
				{#snippet confirm()}
					<input type="hidden" name="token" value={preview.token} />
					{#if preview.issues.length > 0}
						<label class="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								name="allowRowIssues"
								class="mt-0.5 size-4 accent-primary"
								aria-invalid={fieldProblems.allowRowIssues ? 'true' : undefined}
							/>
							<span>
								Загрузить только верные строки ({preview.rowsValid} из {preview.rowsRead}); строки с ошибками не попадут
								в профили
							</span>
						</label>
					{/if}
					<Button type="submit" formaction="?/import" class="w-fit" disabled={pending !== null || changed}>
						<UploadIcon aria-hidden="true" />
						{pending === 'import' ? 'Загружаем…' : 'Загрузить пакет'}
					</Button>
				{/snippet}
			</BatchPreview>
		{/if}
	</form>
{/if}

<BatchHistory history={data.history} />
