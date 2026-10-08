<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ResolvedPathname } from '$app/types';
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
	import BookmarkCheckIcon from '@lucide/svelte/icons/bookmark-check';
	import SendIcon from '@lucide/svelte/icons/send';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { categoryName } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import {
		basisOf,
		COMPONENT_NAMES,
		COMPONENT_REASONS,
		contribution,
		compositeText,
		coverageText,
		OFFER_FIT,
		reasonText,
		unconfirmedText,
		type NeedMatchData,
		type ShortlistNames
	} from './shortlist.js';

	/**
	 * A candidate of a shortlist (domain 13.10): the category, the required skills not confirmed and what stands for each,
	 * the score with the exact contribution of every component, 3–5 reasons with their sources, the skills of the need
	 * by their basis, the position without FSP; a candidate of the group «грейд не подтверждён» says so, what they
	 * declared and what stands confirmed,
	 * whether the offer suits the candidate by what the card shows, the mark and the way to an offer.
	 */
	interface Props {
		pseudonym: string;
		match: NeedMatchData;
		offerFit: { format: string | null; region: string | null };
		mark: { note: string | null } | null;
		hasFsp: boolean;
		/** A candidate created within the viewer's demo session, not a clone of the cast: the visitor's own. */
		createdInSession: boolean;
		names: ShortlistNames;
		cardHref: ResolvedPathname;
		/** The query the card opens the offer with: the shortlist it comes from. */
		offerQuery: string;
		/** The marks can be changed: the latest step of an open shortlist. */
		editable: boolean;
	}

	let { pseudonym, match, offerFit, mark, hasFsp, createdInSession, names, cardHref, offerQuery, editable }: Props =
		$props();

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
	const unconfirmed = $derived(coverageText(match.coverage, names));
	const composite = $derived(compositeText(match.composite, names));
	const notConfirmed = $derived(match.group === 'unconfirmed' ? unconfirmedText(match, names) : null);
</script>

<article class="grid gap-3 rounded-xl border bg-card p-4 sm:p-5" data-candidate={pseudonym} data-testid="shortlist-row">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="grid gap-1">
			<h3 class="font-heading text-h3">
				<span class="text-muted-foreground numeric">#{match.position}</span>
				<a class="hover:underline" href={cardHref} data-sveltekit-preload-data="tap">Кандидат {pseudonym}</a>
			</h3>
			<p class="text-sm text-muted-foreground">
				{#if match.category}
					{categoryName(match.category, names)}
				{:else}
					<span class="font-medium text-foreground" data-testid="grade-not-confirmed">грейд не подтверждён</span>
					{#if match.declared}· указано кандидатом: {categoryName(match.declared, names)}{/if}
				{/if}
				· {hasFsp ? 'есть результаты ФСП' : 'без результатов ФСП'}
				{#if createdInSession}
					· <span class="font-medium text-foreground" data-testid="created-in-session">создан в вашей демо-сессии</span>
				{/if}
			</p>
		</div>
		<div class="text-right">
			<span class="font-heading text-h2 text-link numeric">{percent.format(match.score)}</span>
			<span class="block text-xs text-muted-foreground">
				потребность {percent.format(match.levels.need)} · сила профиля {percent.format(match.levels.strength)}
			</span>
		</div>
	</div>

	{#if notConfirmed}
		<div
			class="grid gap-1 rounded-lg border border-dashed border-trust-claimed-border p-3 text-sm"
			data-testid="shortlist-not-confirmed"
		>
			<p>{notConfirmed.grade}</p>
			<p class="text-muted-foreground">{notConfirmed.confirmed}</p>
		</div>
	{/if}
	{#if composite}
		<p class="text-sm" data-testid="shortlist-composite-role">{composite}</p>
	{/if}
	{#if unconfirmed}
		<p class="text-sm" data-testid="shortlist-unconfirmed">{unconfirmed}</p>
	{/if}

	<div class="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
		<div class="flex h-full">
			<div class="bg-link" style:width={`${match.levels.need * 100}%`}></div>
			<div class="bg-success" style:width={`${match.levels.strength * 100}%`}></div>
		</div>
	</div>

	<section aria-label={match.group === 'unconfirmed' ? 'Почему в подборке' : 'Почему подходит'}>
		<h4 class="mb-1 text-sm font-medium">{match.group === 'unconfirmed' ? 'Почему в подборке' : 'Почему подходит'}</h4>
		<ol class="grid gap-1 text-sm" data-testid="shortlist-reasons">
			{#each match.reasons as reason, index (index)}
				{@const view = reasonText(reason, names)}
				<li class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
					<span>
						{view.text}
						<span class="block text-xs text-muted-foreground">Источник: {view.source}</span>
					</span>
					<span class="font-mono text-xs text-muted-foreground">{contribution(reason.contribution)}</span>
				</li>
			{/each}
		</ol>
	</section>

	<div class="flex flex-wrap gap-1.5" aria-label="Навыки потребности">
		{#each match.skills as skill (skill.skill_key)}
			{@const basis = basisOf(skill.basis, match.group)}
			<span class={`rounded-full px-2 py-0.5 text-xs ${basis.tone}`} data-basis={skill.basis}>
				{names.skills[skill.skill_key] ?? skill.skill_key}{skill.requirement === 'nice' ? ' (желательно)' : ''} · {basis.label}
			</span>
		{/each}
	</div>

	<p class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
		<span data-testid="position-without-fsp">
			{#if match.positionWithoutFsp === match.position}
				без ФСП — та же позиция
			{:else}
				без ФСП — позиция {match.positionWithoutFsp}
			{/if}
		</span>
		{#if match.tieBrokenBySemantic}
			<span>почти равны с соседями: порядок по смысловой близости к тексту потребности</span>
		{/if}
		{#if offerFit.format !== null}
			<span>формат подходит: {OFFER_FIT[offerFit.format]}</span>
		{/if}
		{#if offerFit.region !== null}
			<span>регион: {OFFER_FIT[offerFit.region]}</span>
		{/if}
		{#if match.toVerify.length > 0}
			<span>проверить на собеседовании: {match.toVerify.map((key) => names.skills[key] ?? key).join(', ')}</span>
		{/if}
	</p>

	<details class="rounded-lg border text-sm">
		<summary class="cursor-pointer px-3 py-2 font-medium">Разложение счёта</summary>
		<table class="w-full border-t text-xs">
			<thead>
				<tr class="text-left text-muted-foreground">
					<th class="px-3 py-1 font-normal">Компонент</th>
					<th class="px-3 py-1 font-normal">Вес</th>
					<th class="px-3 py-1 font-normal">Значение</th>
					<th class="px-3 py-1 font-normal">Вклад</th>
				</tr>
			</thead>
			<tbody>
				{#each Object.entries(match.components) as [key, component] (key)}
					{#if component.applicable}
						<tr class="border-t">
							<td class="px-3 py-1">
								{COMPONENT_NAMES[key] ?? key}
								{#if component.reason}
									<span class="block text-muted-foreground"
										>{COMPONENT_REASONS[component.reason] ?? component.reason}</span
									>
								{/if}
							</td>
							<td class="px-3 py-1 font-mono">{component.weight}</td>
							<td class="px-3 py-1 font-mono">{component.value}</td>
							<td class="px-3 py-1 font-mono">{contribution(component.contribution)}</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</details>

	<div class="flex flex-wrap items-center gap-2">
		<a class={buttonVariants({ size: 'sm' })} href="{cardHref}{offerQuery}" data-testid="shortlist-offer">
			<SendIcon aria-hidden="true" /> Предложить работу
		</a>
		{#if editable}
			{#if mark}
				<form method="POST" action="?/unmark" use:enhance>
					<CsrfInput />
					<input type="hidden" name="pseudonym" value={pseudonym} />
					<Button type="submit" size="sm" variant="outline">
						<BookmarkCheckIcon aria-hidden="true" /> Отмечен{mark.note ? `: ${mark.note}` : ''} — снять
					</Button>
				</form>
			{:else}
				<form method="POST" action="?/mark" use:enhance class="flex flex-wrap items-center gap-2">
					<CsrfInput />
					<input type="hidden" name="pseudonym" value={pseudonym} />
					<Input name="note" maxlength={500} placeholder="Заметка (видна только компании)" class="h-8 w-56" />
					<Button type="submit" size="sm" variant="outline"><BookmarkIcon aria-hidden="true" /> Отметить</Button>
				</form>
			{/if}
		{/if}
	</div>
</article>
