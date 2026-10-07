<script lang="ts" module>
	import type { ParseStatus } from './quotes';

	export interface ResumeUploadView {
		resumeDocumentId: string;
		isCurrent: boolean;
		parseStatus: ParseStatus;
		/** Why the parse gave no text (`resume_documents.parse_error`); `null` while pending or after a parse with text. */
		parseError: string | null;
		declaredName: string;
		sizeBytes: number;
		uploadedAt: Date;
	}
</script>

<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { PARSE_STATUSES } from './quotes';
	import ResumeDelete from './resume-delete.svelte';

	/** Every upload of the candidate, newest first, with where its reading stands. */
	let {
		uploads,
		extracting
	}: {
		uploads: ResumeUploadView[];
		/** The current resume is parsed and its fields are still being extracted. */
		extracting: boolean;
	} = $props();

	const sizeFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });

	function size(bytes: number): string {
		if (bytes < 1024 * 1024) return `${sizeFormat.format(Math.max(1, Math.round(bytes / 1024)))} КиБ`;
		return `${sizeFormat.format(bytes / (1024 * 1024))} МиБ`;
	}

	function status(upload: ResumeUploadView) {
		if (upload.isCurrent && extracting) return { label: 'Извлекаем поля', tone: 'info' as const };
		// Not a defect of the file: it was not read because the consent to process the data is not in effect.
		if (upload.parseError === 'no_processing_consent')
			return { label: 'Нет согласия на обработку', tone: 'warning' as const };
		return PARSE_STATUSES[upload.parseStatus];
	}
</script>

<ul class="grid gap-2" aria-label="Загруженные резюме" data-testid="resume-uploads">
	{#each uploads as upload (upload.resumeDocumentId)}
		{@const shown = status(upload)}
		<li
			class="grid gap-2 rounded-lg border p-3"
			data-parse-status={upload.parseStatus}
			data-current={upload.isCurrent ? 'true' : 'false'}
		>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="flex min-w-0 items-center gap-2">
					<FileTextIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<div class="min-w-0">
						<p class="truncate font-medium">{upload.declaredName}</p>
						<p class="text-xs text-muted-foreground">
							{size(upload.sizeBytes)} · загружено {formatDateTime(upload.uploadedAt)}
						</p>
					</div>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					{#if upload.isCurrent}<StatusPill label="Текущее" />{:else}<StatusPill label="Прежнее" />{/if}
					<span class="inline-flex items-center gap-1.5">
						{#if upload.isCurrent && (upload.parseStatus === 'pending' || extracting)}
							<Spinner aria-hidden="true" role="presentation" class="text-info" />
						{/if}
						<StatusPill label={shown.label} tone={shown.tone} />
					</span>
					<ResumeDelete
						resumeDocumentId={upload.resumeDocumentId}
						name={upload.declaredName}
						counted={upload.isCurrent && (upload.parseStatus === 'parsed' || upload.parseStatus === 'partial')}
					/>
				</div>
			</div>
			<!-- How the current resume was read, or why it was not, is told below the list. -->
			{#if !upload.isCurrent}
				<p class="text-xs text-muted-foreground">
					Заменено новым файлом и в профиле не учитывается. Удалите, если хранить его больше не нужно.
				</p>
			{/if}
		</li>
	{/each}
</ul>
