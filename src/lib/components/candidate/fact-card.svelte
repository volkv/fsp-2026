<script lang="ts">
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import ReceiptIcon from '@lucide/svelte/icons/receipt-text';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolve } from '$app/paths';
	import { AchievementBadge, TrustChip, VerificationReceipt } from '$lib/components/product/index.js';
	import {
		formatDate,
		RECEIPT_SOURCE_TRUST,
		type AchievementView,
		type ReceiptSource,
		type ReceiptView
	} from '$lib/components/product/model.js';
	import { cn } from '$lib/components/utils.js';
	import {
		asAward,
		asDiscipline,
		asEvsk,
		asLevel,
		assertion,
		disciplineName,
		FACT_SOURCES,
		factTitle,
		OWNERSHIP_BASES,
		rankName,
		SQUADS,
		STAGES,
		TEAM_ROLES,
		skillName,
		type FactView,
		type Labels
	} from './model.js';

	/**
	 * One fact of the profile as its owner sees it: the fact itself, where it came from, what its receipt confirms and
	 * does not, and which skills it counts toward.
	 */
	let { fact, labels, class: className }: { fact: FactView; labels: Labels; class?: string } = $props();

	const detail = $derived(fact.detail);

	const achievement = $derived.by((): AchievementView | null => {
		if (detail.kind !== 'competition_result') return null;
		return {
			discipline: asDiscipline(detail.discipline),
			level: asLevel(detail.level),
			award: asAward(detail.award),
			format: detail.format,
			season: detail.season,
			team: detail.team !== null,
			evskIndicator: asEvsk(detail.evskIndicator),
			exact: {
				competition: detail.competition,
				place: detail.place,
				...(detail.placeOf === null ? {} : { placeOf: detail.placeOf }),
				...(detail.team ? { teamName: detail.team.name } : {})
			}
		};
	});

	const receiptSource = $derived.by((): ReceiptSource | null => {
		if (fact.source === 'fsp' || fact.source === 'platform_test') return fact.source;
		if (fact.source === 'codeforces' || fact.source === 'github') return fact.source;
		return null;
	});

	const receipt = $derived.by((): ReceiptView | null => {
		if (!fact.receipt || receiptSource === null) return null;
		return {
			handle: fact.receipt.handle,
			source: receiptSource,
			title: factTitle(detail),
			verifiedAt: fact.receipt.verifiedAt,
			status: fact.receipt.status,
			disclosure: 'generalized',
			asserts: Object.entries(fact.receipt.asserts).map(([key, value]) => assertion(key, value)),
			doesNotAssert: fact.receipt.doesNotAssert,
			signingKeyId: fact.receipt.signingKeyId
		};
	});

	const trust = $derived(receiptSource === null ? fact.trustLevel : RECEIPT_SOURCE_TRUST[receiptSource]);
</script>

<article
	class={cn(
		'grid gap-4 rounded-xl border bg-card p-4 shadow-xs',
		fact.status === 'annulled' && 'border-dashed',
		className
	)}
	aria-label={factTitle(detail)}
	data-fact-status={fact.status}
	data-testid="fact-card"
>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<TrustChip level={trust} register="sport" size="md" signal />
		<p class="text-xs text-muted-foreground">
			Сверено {formatDate(fact.lastVerifiedAt)}
		</p>
	</div>

	{#if fact.status === 'annulled'}
		<p class="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-warning">
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<span>
				Источник аннулировал этот результат{fact.statusReason ? `: ${fact.statusReason}` : ''}. Он больше не
				засчитывается в навыки и категорию.
			</span>
		</p>
	{/if}

	{#if achievement && detail.kind === 'competition_result'}
		<AchievementBadge {achievement} class="border-0 p-0 shadow-none" />
		<dl class="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Этап:</dt>
				<dd>{detail.stage === null ? 'не передан' : (STAGES[detail.stage] ?? detail.stage)}</dd>
			</div>
			{#if detail.team}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">Роль в команде:</dt>
					<dd>{detail.team.role === null ? 'не передана' : (TEAM_ROLES[detail.team.role] ?? detail.team.role)}</dd>
				</div>
			{/if}
			{#if detail.resultStatus !== 'official'}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">Статус результата:</dt>
					<dd>предварительный — не засчитывается, пока источник его не утвердит</dd>
				</div>
			{/if}
		</dl>
		{#if detail.protocolUrl}
			<a
				href={detail.protocolUrl}
				class="inline-flex w-fit items-center gap-1 text-sm text-link underline underline-offset-4"
				target="_blank"
				rel="external noopener noreferrer"
			>
				Протокол соревнования
				<ExternalLinkIcon class="size-3.5" aria-hidden="true" />
				<span class="sr-only">(откроется в новой вкладке)</span>
			</a>
		{/if}
	{:else if detail.kind === 'qualification'}
		<p class="font-heading text-lg">{rankName(detail.rank)}</p>
		<p class="text-sm">{disciplineName(detail.discipline)}, присвоен {formatDate(detail.assignedAt)}</p>
	{:else if detail.kind === 'national_team'}
		<p class="font-heading text-lg">Сборная России, {SQUADS[detail.squad]}</p>
		<p class="text-sm">{disciplineName(detail.discipline)}, сезон {detail.season}</p>
	{:else if detail.kind === 'platform_rating'}
		<p class="font-heading text-lg">{detail.platform}: {detail.login}</p>
		<p class="text-sm text-muted-foreground">
			Рейтинг {detail.rating ?? 'не передан'} — в уровень ФСП не входит: шкала платформы не сверена.
		</p>
	{:else if detail.kind === 'test_block'}
		<p class="font-heading text-lg">{detail.title}</p>
		<p class="text-sm" data-testid="test-block">
			Подтверждено по запросу работодателя, выпуск банка {detail.bankReleaseId}, {formatDate(detail.decidedOn)}.
			Покрывает только навыки блока: {detail.skillKeys.join(', ') || 'навыков в справочнике нет'}; грейд и категорию не
			меняет.
		</p>
	{:else if detail.kind === 'test_score'}
		<p class="font-heading text-lg">Тест на грейд {detail.title}</p>
		<dl class="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2" data-testid="test-score">
			<div class="flex gap-1.5 sm:col-span-2">
				<dt class="text-muted-foreground">Пройденные блоки:</dt>
				<dd>{detail.blocks.length > 0 ? detail.blocks.join(', ') : 'нет'}</dd>
			</div>
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Выпуск банка:</dt>
				<dd class="tabular-nums">{detail.bankReleaseId}</dd>
			</div>
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Решение:</dt>
				<dd>{formatDate(detail.decidedOn)}</dd>
			</div>
		</dl>
		<p class="text-sm text-muted-foreground">
			Подтверждено выполнение заданий этого теста в его условиях: без надзора, с лимитами и журналом сигналов. Это не
			доказательство самостоятельного выполнения и не оценка всей квалификации.
		</p>
		<a
			href={resolve('/(app)/me/tests/decisions/[decisionId]', { decisionId: detail.decisionId })}
			class="w-fit text-sm text-link underline underline-offset-4"
		>
			Открыть решение
		</a>
	{:else}
		<p class="font-heading text-lg">{factTitle(detail)}</p>
	{/if}

	<p class="text-sm">
		<span class="text-muted-foreground">Откуда:</span>
		{FACT_SOURCES[fact.source]} — {OWNERSHIP_BASES[fact.ownershipBasis] ?? fact.ownershipBasis}; получено {formatDate(
			fact.observedAt
		)}.
	</p>

	{#if fact.supports.length > 0}
		<div class="grid gap-1.5">
			<p class="text-sm font-medium">Засчитано в навыки</p>
			<ul class="flex flex-wrap gap-1.5" aria-label="Навыки, которые подкрепляет этот факт">
				{#each fact.supports as item (item.skillKey)}
					<li>
						<TrustChip
							level={item.attestation === 'direct' ? trust : item.attestation === 'claimed' ? 'claimed' : 'derived'}
							skill={skillName(labels, item.skillKey)}
							register="sport"
						/>
					</li>
				{/each}
			</ul>
		</div>
	{:else if fact.status === 'active'}
		<p class="text-sm text-muted-foreground">
			Пока не засчитан ни в один навык: правила не связывают этот факт с навыками или категория ещё пересчитывается.
		</p>
	{/if}

	{#if receipt}
		<details class="group rounded-lg border" data-testid="fact-receipt">
			<summary
				class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
			>
				<ReceiptIcon class="size-4 text-link" aria-hidden="true" />
				Квитанция проверки: что подтверждено и чего нет
			</summary>
			<div class="p-3 pt-0">
				<VerificationReceipt {receipt} simulator={fact.receipt?.simulator} class="border-0 shadow-none" />
				<p class="mt-2 text-xs text-muted-foreground">
					Работодатель получает свою квитанцию на тот же факт: он проверяет её подпись, не узнавая, кто вы.
				</p>
			</div>
		</details>
	{:else if fact.trustLevel !== 'claimed' && fact.status === 'active'}
		<p class="text-sm text-muted-foreground">Квитанция проверки для этого факта ещё не выпущена.</p>
	{/if}
</article>
