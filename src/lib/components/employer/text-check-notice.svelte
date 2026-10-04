<script lang="ts">
	import OctagonAlertIcon from '@lucide/svelte/icons/octagon-alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';

	/**
	 * Findings of the check of a vacancy text for discriminatory requirements (domain 13.1): a blocking phrase sends the
	 * vacancy to an operator instead of the catalog, a warning needs the employer's confirmation. What a blocked text
	 * means depends on the moderation case: before publication it will go to the operator, in moderation it waits for
	 * the operator unless the text is fixed, an approval holds while the phrases stay, a rejection closed the vacancy.
	 * A clean text shows nothing.
	 */
	interface Phrase {
		rule: string;
		severity: 'block' | 'warning';
		text: string;
		explanation: string;
	}

	interface Moderation {
		decision: { outcome: 'published' | 'returned' | 'rejected' } | null;
	}

	let {
		check
	}: {
		check: { result: 'clean' | 'warnings' | 'blocked'; phrases: Phrase[]; moderation?: Moderation | null };
	} = $props();

	type Stage = 'before' | 'pending' | 'approved' | 'rejected';
	const stage: Stage = $derived.by(() => {
		const moderation = check.moderation ?? null;
		if (moderation === null) return 'before';
		switch (moderation.decision?.outcome) {
			case undefined:
				return 'pending';
			case 'published':
				return 'approved';
			case 'rejected':
				return 'rejected';
			case 'returned':
				return 'before';
		}
	});
	const BLOCKED: Record<Stage, { title: string; text: string }> = {
		before: {
			title: 'В тексте есть недопустимые требования',
			text: 'Сразу в каталог такая вакансия не попадёт: после публикации её посмотрит оператор ФСП. Если требование законно — например, гражданство для допуска к гостайне, — он опубликует вакансию, если нет — вернёт на правку или отклонит. Чтобы опубликовать без ожидания, уберите или перепишите фрагменты ниже.'
		},
		pending: {
			title: 'Из-за этих требований вакансия на модерации',
			text: 'Оператор ФСП решит, законны ли они. Не хотите ждать — уберите или перепишите фрагменты ниже: если проверка пройдёт, вакансия сразу выйдет из модерации.'
		},
		approved: {
			title: 'Оператор ФСП допустил эти требования',
			text: 'Пока фрагменты ниже не меняются, модерация не нужна. Новое требование такого рода снова отправит вакансию к оператору.'
		},
		rejected: {
			title: 'Оператор ФСП отклонил вакансию из-за этих требований',
			text: 'Вакансия закрыта. Чтобы нанимать на эту позицию, создайте новую вакансию без фрагментов ниже.'
		}
	};
	const blocked = $derived(BLOCKED[stage]);
</script>

{#if check.result !== 'clean'}
	<Alert.Root
		class={check.result === 'blocked' && stage !== 'approved'
			? 'border-destructive/40 bg-danger-subtle'
			: 'border-warning/40 bg-warning-subtle'}
		data-testid="text-check"
		data-result={check.result}
		data-stage={check.result === 'blocked' ? stage : undefined}
	>
		{#if check.result === 'blocked'}
			{#if stage === 'approved'}
				<TriangleAlertIcon aria-hidden="true" class="text-warning" />
			{:else}
				<OctagonAlertIcon aria-hidden="true" class="text-destructive" />
			{/if}
			<Alert.Title>{blocked.title}</Alert.Title>
		{:else}
			<TriangleAlertIcon aria-hidden="true" class="text-warning" />
			<Alert.Title>Проверьте формулировки текста</Alert.Title>
		{/if}
		<Alert.Description class="grid gap-2">
			<p>
				{check.result === 'blocked'
					? blocked.text
					: 'Перед публикацией подтвердите, что формулировки связаны с деловыми качествами.'}
			</p>
			<ul class="grid gap-1.5">
				{#each check.phrases as phrase, index (index)}
					<li>
						<mark class="rounded-sm bg-background px-1 font-medium">{phrase.text}</mark>
						<span class="text-foreground/80"> — {phrase.explanation}</span>
					</li>
				{/each}
			</ul>
		</Alert.Description>
	</Alert.Root>
{/if}
