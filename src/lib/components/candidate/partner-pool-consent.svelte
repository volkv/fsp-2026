<script lang="ts">
	import { enhance } from '$app/forms';
	import HandshakeIcon from '@lucide/svelte/icons/handshake';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import { AWARDS, formatDate, type Award } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';

	/**
	 * The pools of competition partners, one consent per competition where the candidate is a finalist: who sees the card
	 * (the partner companies named at the moment of the consent) and what (the pseudonymous catalog card with the result
	 * of this competition exact). A partner added later sees nothing until the candidate consents again.
	 */
	interface Offer {
		competitionRef: string;
		competition: { title: string; stage: string | null; startDate: string } | null;
		result: { place: number | null; award?: string } | null;
		partners: { companyId: string; name: string }[];
		consent: { grantedAt: Date; partners: string[]; effective: boolean } | null;
		newPartners: string[];
	}

	interface Props {
		adult: boolean;
		offers: Offer[];
		text: { id: string; title: string; version: number; body: string } | null;
	}

	let { adult, offers, text }: Props = $props();

	const awardText = (award: string | undefined) =>
		award !== undefined && award in AWARDS ? AWARDS[award as Award] : 'результат не передан';
</script>

{#if !adult}
	<p class="text-sm" data-testid="partner-pool-minor">
		Пулы партнёров соревнований — только с 18 лет. До совершеннолетия работодатель увидит вас лишь в контексте
		подходящей стажировки.
	</p>
{:else if offers.length === 0}
	<p class="text-sm text-muted-foreground">
		Сейчас нет соревнований, где вы в финале и у которых есть действующие партнёры. Когда оператор ФСП откроет
		партнёрство, здесь появится отдельное согласие для этого соревнования.
	</p>
{:else}
	<ul class="grid gap-4">
		{#each offers as offer (offer.competitionRef)}
			<li class="grid gap-3 rounded-lg border p-4 text-sm" data-pool-competition={offer.competitionRef}>
				<div class="flex flex-wrap items-start gap-2">
					<HandshakeIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<div class="grid gap-0.5">
						<span class="font-medium">{offer.competition?.title ?? `Соревнование ${offer.competitionRef}`}</span>
						{#if offer.result}
							<span class="text-muted-foreground">
								Ваш результат: {awardText(offer.result.award)}{offer.result.place !== null
									? `, ${offer.result.place} место`
									: ''}{offer.competition ? ` · ${formatDate(offer.competition.startDate)}` : ''}
							</span>
						{/if}
					</div>
				</div>

				<div class="grid gap-1">
					<p>
						<span class="font-medium">Кто увидит:</span>
						{#if offer.consent}
							{offer.consent.partners.join(', ')} — компании-партнёры на момент согласия.
						{:else}
							{offer.partners.map((partner) => partner.name).join(', ')} — компании-партнёры этого соревнования.
						{/if}
					</p>
					<p>
						<span class="font-medium">Что увидят:</span> карточку под псевдонимом, как в каталоге: категорию, навыки с квитанциями
						и точный результат этого соревнования. Имя и контакты — только после принятого приглашения и вашего согласия на
						раскрытие.
					</p>
				</div>

				{#if offer.consent}
					<p data-testid="partner-pool-granted">
						Согласие дано {formatDate(offer.consent.grantedAt)}.
						{#if !offer.consent.effective}
							<span class="text-muted-foreground">Сейчас оно не действует: текст согласия обновился.</span>
						{/if}
					</p>
				{/if}

				{#if offer.partners.length > 0 && text && (!offer.consent || offer.newPartners.length > 0 || !offer.consent.effective)}
					<form method="POST" action="?/poolGrant" use:enhance class="grid gap-3">
						<CsrfInput />
						<input type="hidden" name="documentId" value={text.id} />
						<input type="hidden" name="competitionRef" value={offer.competitionRef} />
						{#if offer.consent && offer.newPartners.length > 0}
							<p>
								Новые партнёры: {offer.newPartners.join(', ')}. Они не видят вас, пока вы не дадите согласие заново.
							</p>
						{/if}
						<details class="rounded-lg border" open={!offer.consent}>
							<summary class="cursor-pointer px-3 py-2 font-medium">{text.title} · редакция {text.version}</summary>
							<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<div
								class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
								role="region"
								aria-label="Текст согласия"
								tabindex="0"
							>
								{text.body}
							</div>
						</details>
						<Button type="submit" class="justify-self-start">
							{offer.consent ? 'Обновить согласие' : 'Даю согласие показать карточку партнёрам'}
						</Button>
					</form>
				{:else if offer.partners.length > 0 && !text}
					<p class="text-muted-foreground">Текст согласия на пул партнёров не опубликован.</p>
				{/if}

				{#if offer.consent}
					<form method="POST" action="?/poolRevoke" use:enhance>
						<CsrfInput />
						<input type="hidden" name="competitionRef" value={offer.competitionRef} />
						<Button type="submit" variant="outline" size="sm">Убрать карточку из пула партнёров</Button>
					</form>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
