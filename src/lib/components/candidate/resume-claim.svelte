<script lang="ts">
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { cn } from '$lib/components/utils.js';
	import { roleName, skillName, type Labels } from './model.js';
	import { CLAIM_TYPES, REVIEW_STATES, reviewState, type ResumeClaimView } from './quotes';
	import ResumeReview from './resume-review.svelte';

	/**
	 * One field extracted from the resume: what it says, the quote it rests on — a click shows the quote in the text —
	 * and the candidate's decision on it.
	 */
	let {
		claim,
		labels,
		located,
		selected,
		documentId,
		problem,
		onshow
	}: {
		claim: Omit<ResumeClaimView, 'experienceEntryId'>;
		labels: Labels;
		/** The quote lies in the text shown on the page. */
		located: boolean;
		selected: boolean;
		documentId: string;
		problem: string | null;
		onshow: (key: string) => void;
	} = $props();

	const review = $derived(reviewState(claim.candidateReview));

	/** A string field of the claim value, when the value has it. */
	function valueField(name: string): string | null {
		const value = claim.value;
		if (typeof value !== 'object' || value === null || !(name in value)) return null;
		const field = (value as Record<string, unknown>)[name];
		return typeof field === 'string' ? field : null;
	}

	const title = $derived.by(() => {
		if (claim.claimType === 'skill_mention' && claim.skillKey !== null) return skillName(labels, claim.skillKey);
		if (claim.claimType === 'language_level') {
			const level = valueField('level');
			return level === null ? claim.rawText : `${claim.rawText} — ${level}`;
		}
		return claim.rawText;
	});

	const detail = $derived.by(() => {
		if (claim.claimType === 'skill_mention') {
			if (claim.skillKey === null) return 'Навыка нет в справочнике платформы — в категории он пока не учитывается.';
			return title === claim.rawText ? null : `В резюме: «${claim.rawText}»`;
		}
		if (claim.claimType === 'role_title') {
			const role = valueField('role_key');
			return role === null ? 'Роль по справочнику не определена.' : `Роль: ${roleName(labels, role)}`;
		}
		return null;
	});

	const POLARITIES: Record<string, string> = {
		negated: 'Сказано с отрицанием — например, «не работал с…»: навыком это не считается.',
		uncertain: 'Сказано неуверенно — например, «изучаю…».'
	};
	const polarity = $derived(POLARITIES[claim.polarity] ?? null);
	const shownState = $derived(REVIEW_STATES[review]);
</script>

<article
	class={cn('grid gap-2 rounded-lg border p-3', review === 'rejected' && 'border-dashed')}
	aria-label="{CLAIM_TYPES[claim.claimType] ?? claim.claimType}: {title}"
	data-testid="resume-claim"
	data-claim-type={claim.claimType}
	data-review={review}
>
	<div class="flex flex-wrap items-start justify-between gap-2">
		<div class="grid gap-0.5">
			<p class="text-xs text-muted-foreground">
				{CLAIM_TYPES[claim.claimType] ?? claim.claimType} · {claim.extractor === 'model'
					? 'нашла модель'
					: 'нашли правила'}
			</p>
			<p class={cn('font-medium', review === 'rejected' && 'line-through')}>{title}</p>
			{#if detail}<p class="text-sm text-muted-foreground">{detail}</p>{/if}
			{#if polarity}<p class="text-sm text-warning">{polarity}</p>{/if}
		</div>
		<StatusPill label={shownState.label} tone={shownState.tone} />
	</div>
	<p class="flex items-start gap-1.5 text-sm">
		<QuoteIcon class="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		{#if located}
			<button
				type="button"
				class={cn(
					'rounded-sm text-left text-link underline decoration-dotted underline-offset-4 outline-none hover:decoration-solid focus-visible:ring-3 focus-visible:ring-ring/50',
					selected && 'decoration-solid'
				)}
				aria-controls={documentId}
				aria-pressed={selected}
				onclick={() => {
					onshow(claim.sourceKey);
				}}
			>
				«{claim.quote.text}»<span class="sr-only"> — показать в тексте резюме</span>
			</button>
		{:else}
			<span>
				«{claim.quote.text}»
				<span class="text-muted-foreground">— из прежнего чтения файла, в тексте резюме не отмечено</span>
			</span>
		{/if}
	</p>
	<ResumeReview action="?/reviewClaim" idField="claim_id" id={claim.id} {review} subject={title} />
	{#if problem}<FormMessage text={problem} />{/if}
</article>
