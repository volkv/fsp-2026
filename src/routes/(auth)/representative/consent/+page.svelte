<script lang="ts">
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type Kind = 'pd_processing' | 'catalog_visibility' | 'fsp_import';

	const HINTS: Record<Kind, string> = {
		pd_processing: 'Обязательно: без него профиль не ведётся.',
		catalog_visibility:
			'По желанию: работодатели платформы, кроме заблокированных, увидят обезличенную карточку, и только в контексте подходящей вакансии для подростков.',
		fsp_import: 'По желанию: результаты соревнований подтянутся из систем ФСП, если кандидат привязал ФСП ID.'
	};

	const NAMES: Record<Kind, string> = {
		pd_processing: 'на обработку персональных данных',
		catalog_visibility: 'на показ профиля работодателям',
		fsp_import: 'на получение достижений ФСП'
	};

	/** What a revocation does at once, as the representative confirms it. */
	const CONSEQUENCES: Record<Kind, string> = {
		pd_processing:
			'Без согласия на обработку профиль до 18 лет не ведётся: учётная запись кандидата будет удалена. Вход закроется сразу, неотвеченные приглашения отзовутся, анкета, резюме, достижения и результаты тестов сотрутся в течение 30 дней. Отменить удаление нельзя.',
		catalog_visibility:
			'Профиль сразу перестанет показываться работодателям в каталоге и подборе. Контакты, уже переданные компаниям по приглашениям, останутся у них.',
		fsp_import:
			'Достижения из систем ФСП сразу уйдут из профиля и будут удалены, привязка ФСП ID прекратится, категория кандидата пересчитается без них.'
	};

	const unsigned = $derived(data.form?.texts.filter((text) => !text.signed) ?? []);
	const signed = $derived(data.form?.texts.filter((text) => text.signed) ?? []);
	const confirming = $derived(form && 'confirm' in form ? (form.confirm ?? []) : []);
	const letterRequest = resolve('/representative/letter');
	const namesOf = (kinds: readonly Kind[]) => kinds.map((kind) => NAMES[kind]).join(', ');
	/** An action posted to the page of the link: the page keeps its token for the load after the action. */
	const actionOf = (name: 'sign' | 'revoke') => `?token=${encodeURIComponent(data.token)}&/${name}`;
</script>

<AuthPage
	title="Согласия законного представителя"
	description="Каждое согласие подписывается отдельно и отзывается в любой момент. Подпись и отзыв фиксируются с редакцией текста, временем и адресом, с которого вы открыли ссылку."
	width="wide"
>
	{#if form && 'signed' in form && form.signed}
		<FormMessage
			tone="success"
			text={`Согласия подписаны. Кандидат увидит это в профиле; ссылка из письма больше не действует. ${form.letterSent ? 'Письмо со ссылкой, по которой согласия можно изменить или отозвать, — на вашей почте.' : 'Письмо с новой ссылкой не ушло — запросите его по адресу почты.'}`}
		/>
	{:else if form && 'revoked' in form && form.revoked}
		{#if form.profileDeleted}
			<FormMessage
				tone="success"
				text="Согласие на обработку персональных данных отозвано. Учётная запись кандидата удаляется, кандидат получил письмо об этом."
			/>
		{:else}
			<FormMessage
				tone="success"
				text={`Согласие отозвано: ${namesOf(form.revoked)}. Кандидат получил уведомление. ${form.letterSent ? 'Письмо с новой ссылкой для управления согласиями — на вашей почте.' : 'Письмо с новой ссылкой не ушло — запросите его по адресу почты.'}`}
			/>
		{/if}
	{:else if data.form && confirming.length > 0}
		<section aria-labelledby="revoke-heading" class="grid gap-4" data-testid="revoke-confirmation">
			<h2 id="revoke-heading" class="font-heading text-h3">Отозвать согласие {namesOf(confirming)}?</h2>
			<p>
				Кандидат <strong>{data.form.candidateName}</strong>. Отзыв одной стороной прекращает согласие сразу: снова оно
				начнёт действовать, только когда его подпишут и кандидат, и вы.
			</p>
			<ul class="grid gap-3">
				{#each confirming as kind (kind)}
					<li class="rounded-lg border border-destructive/40 p-4 text-sm" data-consequence={kind}>
						{CONSEQUENCES[kind]}
					</li>
				{/each}
			</ul>
			<form method="POST" action={actionOf('revoke')} class="flex flex-wrap items-center gap-4">
				<CsrfField viewer={data.viewer} />
				<input type="hidden" name="token" value={data.token} />
				<input type="hidden" name="confirmed" value="yes" />
				{#each confirming as kind (kind)}
					<input type="hidden" name="revoke" value={kind} />
				{/each}
				<Button type="submit" size="lg" variant="destructive">Отозвать согласие</Button>
				<a
					class={buttonVariants({ variant: 'outline', size: 'lg' })}
					href="{resolve('/representative/consent')}?token={encodeURIComponent(data.token)}">Не отзывать</a
				>
			</form>
		</section>
	{:else if data.form}
		{#if form && 'message' in form && form.message}
			<FormMessage tone="error" text={form.message} />
		{/if}
		<p>
			Вы — законный представитель кандидата <strong>{data.form.candidateName}</strong>, ваши полномочия проверил
			оператор ФСП. До 18 лет согласие действует, когда его дали и кандидат, и вы.
		</p>
		<form method="POST" action={actionOf('sign')} class="grid gap-6" data-testid="representative-consents">
			<CsrfField viewer={data.viewer} />
			<input type="hidden" name="token" value={data.token} />
			{#each data.form.texts as text (text.kind)}
				<section
					aria-labelledby="consent-{text.kind}"
					class="grid gap-3 rounded-lg border p-4"
					data-consent={text.kind}
					data-signed={text.signed}
				>
					<h2 id="consent-{text.kind}" class="font-heading text-h3">
						{text.title} <span class="text-sm text-muted-foreground">· редакция {text.version}</span>
					</h2>
					<p class="text-sm text-muted-foreground">
						{HINTS[text.kind]}
						{text.candidateSigned ? 'Кандидат своё согласие дал.' : 'Кандидат своё согласие ещё не дал.'}
					</p>
					<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="max-h-64 overflow-y-auto rounded-md bg-muted/30 p-3 text-sm leading-relaxed whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
						role="region"
						aria-label="Текст: {text.title}"
						tabindex="0"
					>
						{text.body}
					</div>
					{#if text.signed}
						<p class="text-sm font-medium text-success">Вы уже подписали это согласие.</p>
						<label class="flex items-center gap-2 text-sm font-medium">
							<input type="checkbox" name="revoke" value={text.kind} class="size-4 accent-destructive" />
							Отозвать
						</label>
					{:else}
						<input type="hidden" name="document_{text.kind}" value={text.id} />
						<label class="flex items-center gap-2 text-sm font-medium">
							<input
								type="checkbox"
								name="consent"
								value={text.kind}
								class="size-4 accent-primary"
								required={text.kind === 'pd_processing'}
							/>
							Даю согласие
						</label>
					{/if}
				</section>
			{/each}
			<div class="flex flex-wrap gap-4">
				{#if unsigned.length > 0}
					<Button type="submit" size="lg">Подписать отмеченные согласия</Button>
				{:else}
					<p class="text-sm text-muted-foreground">Все согласия уже подписаны.</p>
				{/if}
				{#if signed.length > 0}
					<!-- Revoking does not need the required processing consent of the signing form. -->
					<Button type="submit" size="lg" variant="destructive" formaction={actionOf('revoke')} formnovalidate>
						Отозвать отмеченные…
					</Button>
				{/if}
			</div>
		</form>
	{:else}
		<FormMessage
			tone="error"
			text="Ссылка недействительна: она устарела или уже использована, либо полномочия больше не действуют. Новое письмо можно запросить по адресу почты или попросить кандидата отправить его из профиля."
		/>
		<a class="text-link underline underline-offset-4" href={letterRequest}>Запросить новое письмо</a>
	{/if}
</AuthPage>
