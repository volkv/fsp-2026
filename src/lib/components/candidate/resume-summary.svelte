<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import { onMount, tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { cn } from '$lib/components/utils.js';
	import FactCard from './fact-card.svelte';
	import { skillName, type FactView, type Labels } from './model.js';
	import {
		CLAIM_TYPES,
		fieldAnchor,
		listedClaims,
		PARSE_STATUSES,
		periodText,
		REVIEW_STATES,
		reviewState,
		type ResumeClaimView,
		type ResumeSummaryView
	} from './quotes';
	import ResumeDocument from './resume-document.svelte';

	/**
	 * The current resume inside the profile: the file and where its reading stands, the fact it gives the profile with
	 * the skills it counts toward, and every extracted field with its quote — a click on a quote opens the document text
	 * at those words. Checking and correcting the fields is done on the resume page. Another part of the page (a skill
	 * resting on a field) selects a field through `show`; an address with the anchor of a field selects it on arrival.
	 */
	let {
		resume,
		fact,
		labels
	}: {
		resume: ResumeSummaryView;
		/** The fact of this resume in the profile; `null` until its fields are extracted. */
		fact: FactView | null;
		labels: Labels;
	} = $props();

	const id = $props.id();
	const documentId = `${id}-document`;
	const located = $derived(new Set(resume.document?.located ?? []));
	const status = $derived(
		resume.inProgress && resume.upload.parseStatus !== 'pending'
			? { label: 'Извлекаем поля', tone: 'info' as const }
			: PARSE_STATUSES[resume.upload.parseStatus]
	);
	const fields = $derived(listedClaims(resume.claims));

	let documentOpen = $state(false);
	let documentElement = $state<HTMLElement | null>(null);
	let selected = $state<string | null>(null);

	/** Opens the text, selects the quotes of a field, scrolls to the first one and moves focus there. */
	export async function show(key: string) {
		selected = key;
		documentOpen = true;
		await tick();
		const mark = documentElement?.querySelector<HTMLElement>(`mark[data-sources~="${CSS.escape(key)}"]`);
		if (!mark) throw new Error(`no quote of ${key} is marked in the document`);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		mark.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
		mark.focus({ preventScroll: true });
	}

	onMount(() => {
		const anchor = decodeURIComponent(page.url.hash.slice(1));
		const key = [...fields, ...resume.experience].find((field) => fieldAnchor(field.sourceKey) === anchor)?.sourceKey;
		if (key !== undefined && located.has(key)) void show(key);
	});

	function claimTitle(claim: ResumeClaimView): string {
		if (claim.claimType === 'skill_mention' && claim.skillKey !== null) return skillName(labels, claim.skillKey);
		return claim.rawText;
	}

	const quoteClass = (key: string) =>
		cn(
			'rounded-sm text-left text-link underline decoration-dotted underline-offset-4 outline-none hover:decoration-solid focus-visible:ring-3 focus-visible:ring-ring/50',
			selected === key && 'decoration-solid'
		);
</script>

<div class="grid gap-4" data-testid="profile-resume">
	<div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
		<div class="flex items-start gap-2.5">
			<FileTextIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="grid gap-0.5">
				<p class="font-medium break-all">{resume.upload.declaredName}</p>
				<p class="text-xs text-muted-foreground">
					Загружено {formatDateTime(resume.upload.uploadedAt)}{resume.reading
						? resume.reading.model
							? resume.reading.model.runtime === 'api'
								? ' · разобрано внешней моделью через API'
								: resume.reading.model.runtime === 'vllm'
									? ' · разобрано своей моделью платформы'
									: ' · разобрано моделью'
							: ' · разобрано правилами, без модели — проверьте поля'
						: ''}
				</p>
			</div>
		</div>
		<div class="flex flex-wrap items-center gap-3">
			<span data-testid="resume-parse-status" data-status={resume.upload.parseStatus}>
				<StatusPill label={status.label} tone={status.tone} />
			</span>
			<a href={resolve('/me/resume')} class={buttonVariants({ variant: 'outline', size: 'sm' })}>Открыть резюме</a>
		</div>
	</div>

	{#if resume.upload.failureMessage}
		<p class="text-sm text-destructive">{resume.upload.failureMessage}</p>
	{:else if resume.inProgress}
		<p class="text-sm text-muted-foreground">
			Резюме ещё читается: поля с цитатами появятся здесь и на странице резюме, когда разбор закончится.
		</p>
	{/if}

	{#if fact}
		<div id="fact-{fact.id}" class="scroll-mt-32">
			<FactCard {fact} {labels} />
		</div>
	{/if}

	{#if resume.document}
		<div class="grid gap-4 lg:grid-cols-2">
			<section class="grid content-start gap-2" aria-labelledby="{id}-experience">
				<h3 id="{id}-experience" class="text-sm font-semibold">Опыт работы</h3>
				{#if resume.experience.length > 0}
					<ul class="grid gap-2">
						{#each resume.experience as entry (entry.id)}
							{@const review = REVIEW_STATES[reviewState(entry.candidateReview)]}
							{@const period = periodText(entry)}
							<li id={fieldAnchor(entry.sourceKey)} class="grid scroll-mt-32 gap-1 rounded-lg border p-3 text-sm">
								<div class="flex flex-wrap items-start justify-between gap-2">
									<div class="grid gap-0.5">
										<p class="font-medium">{entry.positionTitle ?? 'Должность не найдена'}</p>
										<p>{entry.organizationName ?? 'Компания не найдена'}</p>
										<p class="text-muted-foreground">{period ?? 'Период не найден'}</p>
									</div>
									<StatusPill label={review.label} tone={review.tone} />
								</div>
								{#if located.has(entry.sourceKey)}
									<button
										type="button"
										class={cn('w-fit', quoteClass(entry.sourceKey))}
										aria-controls={documentId}
										aria-pressed={selected === entry.sourceKey}
										onclick={() => show(entry.sourceKey)}
									>
										Показать в тексте резюме<span class="sr-only"> «{entry.positionTitle ?? 'опыт работы'}»</span>
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Опыт работы в резюме не нашёлся — грейд без него не определить.</p>
				{/if}

				<h3 class="mt-2 text-sm font-semibold">Навыки и другие поля</h3>
				{#if fields.length > 0}
					<ul class="grid gap-2" aria-label="Поля резюме">
						{#each fields as claim (claim.id)}
							{@const review = REVIEW_STATES[reviewState(claim.candidateReview)]}
							<li
								id={fieldAnchor(claim.sourceKey)}
								class="grid scroll-mt-32 gap-1 rounded-lg border p-3 text-sm"
								data-testid="profile-resume-claim"
								data-claim-type={claim.claimType}
								data-skill={claim.skillKey ?? undefined}
							>
								<div class="flex flex-wrap items-start justify-between gap-2">
									<p>
										<span class="text-xs text-muted-foreground">{CLAIM_TYPES[claim.claimType] ?? claim.claimType}:</span
										>
										<span class="font-medium">{claimTitle(claim)}</span>
									</p>
									<StatusPill label={review.label} tone={review.tone} />
								</div>
								<p class="flex items-start gap-1.5">
									<QuoteIcon class="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
									{#if located.has(claim.sourceKey)}
										<button
											type="button"
											class={quoteClass(claim.sourceKey)}
											aria-controls={documentId}
											aria-pressed={selected === claim.sourceKey}
											onclick={() => show(claim.sourceKey)}
										>
											«{claim.quote.text}»<span class="sr-only"> — показать в тексте резюме</span>
										</button>
									{:else}
										<span
											>«{claim.quote.text}» <span class="text-muted-foreground">— из прежнего чтения файла</span></span
										>
									{/if}
								</p>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted-foreground">Других полей в резюме не нашлось.</p>
				{/if}
			</section>

			<details id={documentId} class="group grid content-start gap-2 rounded-lg border p-3" bind:open={documentOpen}>
				<summary
					id="{id}-document-title"
					class="cursor-pointer text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				>
					Текст резюме: где стоит каждая цитата
				</summary>
				<div class="mt-2">
					<ResumeDocument
						blocks={resume.document.blocks}
						{selected}
						bind:element={documentElement}
						labelledby="{id}-document-title"
					/>
				</div>
			</details>
		</div>
	{/if}
</div>
