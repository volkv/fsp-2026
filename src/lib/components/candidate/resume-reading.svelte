<script lang="ts">
	import ScanTextIcon from '@lucide/svelte/icons/scan-text';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { DegradedModeNotice, ModelModeLabel } from '$lib/components/product/index.js';
	import type { ModelReadingView } from '$lib/components/product/model.js';

	/**
	 * How the resume was read: by the model, or in the explicit simplified mode by rules only — then every field is to
	 * be checked. Also what the parser could not read in full.
	 */
	let {
		mode,
		model,
		ocrUsed,
		incomplete
	}: {
		mode: 'model' | 'rules_only' | 'partial' | 'failed';
		/** The model that read the resume and where its text went; `null` — no model read it. */
		model: ModelReadingView | null;
		ocrUsed: boolean;
		/** Why the text is partial, in the candidate's words. */
		incomplete: string[];
	} = $props();
</script>

<div class="grid gap-2" data-testid="resume-reading" data-mode={mode}>
	{#if mode === 'model'}
		<aside
			class="flex items-start gap-2.5 rounded-lg border border-info/30 bg-info-subtle px-4 py-3 text-sm text-info"
			aria-label="Как прочитано резюме"
		>
			<SparklesIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div class="space-y-0.5">
				<p class="font-semibold">Разобрано моделью</p>
				<ModelModeLabel reading={model} />
				<p>
					Каждое поле ниже взято из твоего резюме и подкреплено цитатой — нажми на цитату, чтобы увидеть её в тексте.
					Модель тоже ошибается: подтверди верное и отклони лишнее.
				</p>
			</div>
		</aside>
	{:else}
		<DegradedModeNotice operations={['extract']} />
		<ModelModeLabel reading={null} />
		<p class="text-sm text-muted-foreground">
			Поля нашли правила: навыки — по словарю, даты и должности — по шаблонам. У каждого поля есть цитата, но правила
			могли что-то пропустить или понять не так — проверь каждое поле.
		</p>
	{/if}
	{#if ocrUsed}
		<p class="flex items-start gap-2 text-sm text-muted-foreground">
			<ScanTextIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			Текст распознан со скана — сверь цитаты с оригиналом.
		</p>
	{/if}
	{#if incomplete.length > 0}
		<p class="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-warning">
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>Резюме прочитано не полностью: {incomplete.join('; ')}.</span>
		</p>
	{/if}
</div>
