<script lang="ts">
	import { resolve } from '$app/paths';
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
	import { resumeFieldOf, type ResumeSummaryView } from './quotes';

	/**
	 * Skills of the published category grouped by trust: four levels of a fact and the inference without a badge. Each
	 * skill names the facts it rests on; a fact of the profile opens by its anchor, what rests on the resume — on the
	 * page of the resume, named by its field.
	 */
	let {
		skills,
		facts,
		labels,
		resume
	}: {
		skills: SkillView[];
		facts: FactView[];
		labels: Labels;
		/** The current resume, to name the field a source rests on; `null` without one. */
		resume: ResumeSummaryView | null;
	} = $props();

	const ORDER: TrustMark[] = ['fsp_verified', 'platform_verified', 'public_verifiable', 'claimed', 'derived'];

	const grouped = $derived(
		ORDER.map((mark) => ({ mark, items: skills.filter((skill) => skillMark(skill) === mark) })).filter(
			(group) => group.items.length > 0
		)
	);

	/** `anchor` — a fact on this page; `null` — the page of the resume. */
	type Target = { anchor: string | null; title: string };

	/** Where a source of a skill opens: the resume on its page, otherwise its fact; `null` — nowhere. */
	const targetOf = (source: SkillView['sources'][number]): Target | null => {
		if (source.source === 'resume') {
			const field = resume === null ? null : resumeFieldOf(resume, source);
			return { anchor: null, title: field ? `Резюме: ${field.title}` : 'Резюме' };
		}
		const fact = facts.find((item) => item.id === source.factId);
		return fact ? { anchor: `fact-${fact.id}`, title: factTitle(fact.detail) } : null;
	};
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
										{#if target?.anchor}
											<a class="text-link underline underline-offset-4" href="#{target.anchor}">{target.title}</a>
										{:else if target}
											<a class="text-link underline underline-offset-4" href={resolve('/me/resume')}>{target.title}</a>
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
