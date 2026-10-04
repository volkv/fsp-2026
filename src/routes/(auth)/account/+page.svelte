<script lang="ts">
	import LinkIcon from '@lucide/svelte/icons/link';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import AuthPage from '../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
</script>

<AuthPage title="Учётная запись" description="Вход, пароль и сеансы." width="wide">
	{#if data.notice}
		<FormMessage tone={data.notice.tone} text={data.notice.text} />
	{/if}

	<section aria-labelledby="account-profile" class="grid gap-2">
		<h2 id="account-profile" class="font-heading text-h3">Профиль</h2>
		<p>{data.viewer?.displayName}</p>
		<p class="flex flex-wrap items-center gap-2 text-sm">
			<span data-testid="account-email">{data.account.email}</span>
			{#if data.account.emailVerified}
				<Badge variant="secondary">подтверждена</Badge>
			{:else}
				<Badge variant="destructive">не подтверждена</Badge>
				<a class="text-link underline underline-offset-4" href={resolve('/onboarding')}>отправить письмо</a>
			{/if}
		</p>
	</section>

	{#if data.fsp}
		<Separator />
		<section aria-labelledby="account-fsp" class="grid gap-3" data-testid="fsp-section">
			<h2 id="account-fsp" class="font-heading text-h3">ФСП ID</h2>
			{#if form?.unlinkMessage}
				<FormMessage tone="error" text={form.unlinkMessage} />
			{/if}
			{#if data.fsp.identity}
				<p class="text-sm">
					Привязан {dateFormat.format(new Date(data.fsp.identity.linkedAt))}. Идентификатор:
					<code class="font-mono text-xs">{data.fsp.identity.subject}</code>
				</p>
				{#if data.fsp.identity.athleteLinked}
					<p class="flex items-center gap-2 text-sm">
						<TrophyIcon class="size-4 text-link" aria-hidden="true" />
						Достижения импортируются из ФСП по вашему согласию.
					</p>
				{:else if data.fsp.canImport}
					<a href={resolve('/account/fsp-import')} class="{buttonVariants()} justify-self-start">
						<TrophyIcon aria-hidden="true" />
						Подтвердить достижения из ФСП
					</a>
				{/if}
				{#if data.freshAuth}
					<form method="POST" action="?/unlink">
						<CsrfField viewer={data.viewer} />
						<Button type="submit" variant="destructive">Отвязать ФСП ID</Button>
					</form>
					<p class="text-sm text-muted-foreground">
						После отвязки импортированные достижения выводятся из профиля; повторная привязка их не вернёт — нужен новый
						импорт.
					</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						Чтобы отвязать ФСП ID, <a class="text-link underline underline-offset-4" href={resolve('/account/reauth')}
							>подтвердите вход</a
						>.
					</p>
				{/if}
			{:else}
				<p class="text-sm text-muted-foreground">
					Привяжите ФСП ID, чтобы входить через него и подтвердить достижения соревнований. Связь по почте не создаётся:
					нужно войти в ФСП ID.
				</p>
				{#if data.freshAuth}
					<form method="POST" action={resolve('/auth/fsp/link')}>
						<CsrfField viewer={data.viewer} />
						<Button type="submit">
							<LinkIcon aria-hidden="true" />
							Привязать ФСП ID
						</Button>
					</form>
				{:else}
					<a href={resolve('/account/reauth')} class="{buttonVariants({ variant: 'outline' })} justify-self-start">
						Подтвердить вход и привязать
					</a>
				{/if}
			{/if}
		</section>
	{/if}

	<Separator />
	<section aria-labelledby="account-password" class="grid gap-3">
		<h2 id="account-password" class="font-heading text-h3">
			{data.account.hasPassword ? 'Пароль' : 'Задать пароль'}
		</h2>
		{#if form?.passwordMessage}
			<FormMessage tone="error" text={form.passwordMessage} />
		{/if}
		{#if form && 'passwordChanged' in form}
			<FormMessage tone="success" text="Пароль сохранён. Остальные сеансы завершены." />
		{/if}
		{#if data.account.hasPassword || data.freshAuth}
			<form method="POST" action="?/password" use:enhance class="grid gap-4 sm:max-w-sm">
				<CsrfField viewer={data.viewer} />
				<Field.Group>
					{#if data.account.hasPassword}
						<Field.Field>
							<Field.Label for="pw-current">Текущий пароль</Field.Label>
							<Input id="pw-current" name="current" type="password" autocomplete="current-password" required />
						</Field.Field>
					{/if}
					<Field.Field>
						<Field.Label for="pw-next">Новый пароль</Field.Label>
						<Input id="pw-next" name="next" type="password" autocomplete="new-password" required />
						<Field.Description>Не короче 10 символов.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="pw-repeat">Ещё раз</Field.Label>
						<Input id="pw-repeat" name="repeat" type="password" autocomplete="new-password" required />
					</Field.Field>
				</Field.Group>
				<Button type="submit" variant="outline">Сохранить пароль</Button>
			</form>
		{:else}
			<p class="text-sm text-muted-foreground">
				Вы входите только через ФСП ID. Чтобы задать пароль, <a
					class="text-link underline underline-offset-4"
					href={resolve('/account/reauth')}>подтвердите вход</a
				>.
			</p>
		{/if}
	</section>

	<Separator />
	<section aria-labelledby="account-sessions" class="grid gap-3">
		<h2 id="account-sessions" class="font-heading text-h3">Сеансы</h2>
		<p class="text-sm" data-testid="session-count">Открытых сеансов: {data.sessions}</p>
		<form method="POST" action="?/signOutAll">
			<CsrfField viewer={data.viewer} />
			<Button type="submit" variant="outline">Выйти на всех устройствах</Button>
		</form>
	</section>

	<Separator />
	<section aria-labelledby="account-deletion" class="grid gap-3">
		<h2 id="account-deletion" class="font-heading text-h3">Удаление учётной записи</h2>
		<p class="text-sm text-muted-foreground">
			Вход закрывается сразу, данные стираются в течение 30 дней. Для кандидата это же — отзыв согласия на обработку
			персональных данных.
		</p>
		<a
			href={resolve('/account/delete')}
			class="{buttonVariants({ variant: 'destructive' })} justify-self-start"
			data-testid="account-delete">Удалить учётную запись</a
		>
	</section>
</AuthPage>
