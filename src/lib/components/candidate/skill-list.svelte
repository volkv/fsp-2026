<script lang="ts">
	import { TrustChip } from '$lib/components/product/index.js';
	import { pluralize, TRUST, type TrustMark } from '$lib/components/product/model.js';
	import {
		ATTESTATIONS,
		CONTRIBUTION_BASES,
		FACT_SOURCES,
		factTitle,
		skillMark,
		skillName,
		STRENGTH_BANDS,
		type FactView,
		type Labels,
		type SkillView
	} from './model.js';
	import { fieldAnchor, resumeFieldOf, type ResumeSummaryView } from './quotes';

	/**
	 * Skills of the published category grouped by trust: four levels of a fact and the inference without a badge. Each
	 * skill names the facts it rests on; a fact of the profile opens by its anchor, a field of the current resume — by
	 * the anchor of the field, and `onField` selects its quote in the resume text.
	 */
	let {
		skills,
		facts,
		labels,
		resume,
		onField
	}: {
		skills: SkillView[];
		facts: FactView[];
		labels: Labels;
		/** The current resume as the page shows it; `null` without one. */
		resume: ResumeSummaryView | null;
		/** Selects the quote of a field of the resume on the page. */
		onField: (sourceKey: string) => Promise<void>;
	} = $props();

	const ORDER: TrustMark[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed', 'derived'];

	const grouped = $derived(
		ORDER.map((mark) => ({ mark, items: skills.filter((skill) => skillMark(skill) === mark) })).filter(
			(group) => group.items.length > 0
		)
	);

	type Target = { anchor: string; title: string; field: string | null };

	/** Where a source of a skill opens: the field of the resume it rests on, otherwise its fact; `null` — nowhere. */
	const targetOf = (source: SkillView['sources'][number]): Target | null => {
		if (source.source === 'resume' && resume !== null) {
			const field = resumeFieldOf(resume, source);
			if (field) {
				return {
					anchor: fieldAnchor(field.sourceKey),
					title: `Резюме: ${field.title}`,
					field: field.located ? field.sourceKey : null
				};
			}
		}
		const fact = facts.find((item) => item.id === source.factId);
		return fact ? { anchor: `fact-${fact.id}`, title: factTitle(fact.detail), field: null } : null;
	};

	function openField(event: MouseEvent, field: string) {
		// A plain click selects the quote in place; a click to open elsewhere follows the anchor.
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		void onField(field);
	}
</script>

<div class="grid gap-5" data-testid="skill-list">
	{#each grouped as group (group.mark)}
		<section class="grid gap-2" aria-label={TRUST[group.mark].label}>
			<div class="flex flex-wrap items-baseline gap-2">
				<h3 class="text-sm font-semibold">{TRUST[group.mark].sportLabel}</h3>
				<p class="text-xs text-muted-foreground">{TRUST[group.mark].asserts}</p>
			</div>
			<ul class="grid gap-2 sm:grid-cols-2">
				{#each group.items as skill (skill.skillKey)}
					<li class="grid gap-1.5 rounded-lg border p-3" data-skill={skill.skillKey}>
						<div class="flex flex-wrap items-center justify-between gap-2">
							<TrustChip level={group.mark} skill={skillName(labels, skill.skillKey)} register="sport" signal />
							<span class="text-xs text-muted-foreground">{STRENGTH_BANDS[skill.band]}</span>
						</div>
						<details class="text-xs">
							<summary class="cursor-pointer text-muted-foreground">
								Откуда: {skill.sources.length}
								{pluralize(skill.sources.length, ['основание', 'основания', 'оснований'])} · {ATTESTATIONS[
									skill.attestation
								]}
							</summary>
							<ul class="mt-1.5 grid gap-1">
								{#each skill.sources as source, index (index)}
									{@const target = targetOf(source)}
									<li>
										{#if target?.field}
											{@const field = target.field}
											<a
												class="text-link underline underline-offset-4"
												href="#{target.anchor}"
												onclick={(event) => {
													openField(event, field);
												}}>{target.title}</a
											>
										{:else if target}
											<a class="text-link underline underline-offset-4" href="#{target.anchor}">{target.title}</a>
										{:else}
											{FACT_SOURCES[source.source]}
										{/if}
										— {CONTRIBUTION_BASES[source.basis] ?? source.basis}{source.viaSkill
											? ` (через «${skillName(labels, source.viaSkill)}»)`
											: ''}, {ATTESTATIONS[source.attestation]}
									</li>
								{/each}
							</ul>
						</details>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
</div>
