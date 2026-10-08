<script lang="ts">
	import LockKeyholeIcon from '@lucide/svelte/icons/lock-keyhole';
	import * as Card from '$lib/components/ui/card/index.js';

	/**
	 * The place of the candidate's contacts while the company has none (domain 6.5, 13.6): they open only when the
	 * candidate accepts an offer of this company or applies to its vacancy, and only the fields the candidate chooses.
	 * `closed` — the offer of the page ended without acceptance, so nothing was disclosed by it.
	 */
	let { closed = false }: { closed?: boolean } = $props();
</script>

<Card.Root class="border border-dashed bg-muted/30 shadow-none ring-0" data-testid="contacts-hidden">
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<LockKeyholeIcon class="size-5 text-muted-foreground" aria-hidden="true" />
			<h2 class="font-heading text-h3">Контакты кандидата</h2>
		</Card.Title>
		<Card.Description>
			{#if closed}
				Не раскрыты: предложение не принято. ФИО, почта и другие контакты открываются, только когда кандидат принимает
				предложение или сам откликается на вашу вакансию.
			{:else}
				<span class="font-medium text-foreground">Скрыты до принятия предложения или отклика.</span>
				ФИО, почту и другие контакты увидит только ваша компания, когда кандидат примет предложение или сам откликнется на
				вашу вакансию, — и только те поля, которые он выберет.
			{/if}
		</Card.Description>
	</Card.Header>
</Card.Root>
