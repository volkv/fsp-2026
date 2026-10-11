<script lang="ts">
	import { resolve } from '$app/paths';
	import { TrustChip } from '$lib/components/product/index.js';
	import type { TrustMark } from '$lib/components/product/model.js';
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
	 * Skills of the published category as small cards, from the strongest trust down: four levels of a fact and the
	 * inference without a badge. Each skill names the facts it rests on; a fact of the profile opens by its anchor, what rests on the resume — on the
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

	/** Skills from the strongest trust down; within a trust level — as the category lists them. */
	const ordered = $derived(
		ORDER.flatMap((mark) => skills.filter((skill) => skillMark(skill) === mark).map((skill) => ({ skill, mark })))
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

	/** The sources of a skill where they open, each once, with how it counts toward the skill. */
	const sourcesOf = (skill: SkillView) =>
		skill.sources
			.map((source) => {
				const target = targetOf(source);
				const basis = `${CONTRIBUTION_BASES[source.basis] ?? source.basis}${
					source.viaSkill ? ` (через «${skillName(labels, source.viaSkill)}»)` : ''
				}, ${ATTESTATIONS[source.attestation]}`;
				return {
					title: target?.title ?? FACT_SOURCES[source.source],
					anchor: target?.anchor ?? null,
					linked: target !== null,
					basis
				};
			})
			.filter((item, index, all) => all.findIndex((other) => other.title === item.title) === index);
</script>

<ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="skill-list">
	{#each ordered as { skill, mark } (skill.skillKey)}
		<li class="grid content-start gap-2 rounded-xl border bg-card p-4" data-skill={skill.skillKey} data-trust={mark}>
			<div class="flex items-center justify-between gap-2">
				<TrustChip level={mark} register="sport" />
				<span class="text-xs text-muted-foreground">{STRENGTH_BANDS[skill.band]}</span>
			</div>
			<p class="font-semibold">{skillName(labels, skill.skillKey)}</p>
			<p class="line-clamp-2 text-xs text-muted-foreground">
				<span class="sr-only">Откуда, {ATTESTATIONS[skill.attestation]}:</span>
				{#each sourcesOf(skill) as source, index (source.title)}
					{#if index > 0}<span aria-hidden="true" class="mx-1">·</span>{/if}
					{#if source.anchor}
						<a class="underline-offset-4 hover:text-link hover:underline" href="#{source.anchor}" title={source.basis}
							>{source.title}</a
						>
					{:else if source.linked}
						<a
							class="underline-offset-4 hover:text-link hover:underline"
							href={resolve('/me/resume')}
							title={source.basis}>{source.title}</a
						>
					{:else}
						<span title={source.basis}>{source.title}</span>
					{/if}
				{/each}
			</p>
		</li>
	{/each}
</ul>
