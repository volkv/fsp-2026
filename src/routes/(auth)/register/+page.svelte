<script lang="ts">
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { LOGIN_HREF, SIGN_IN_HREF } from '$lib/navigation.js';
	import AuthPage from '../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const values = $derived(form?.values);
	const errors: Partial<Record<string, string>> = $derived(form?.errors ?? {});
	let role = $derived(values?.role ?? 'candidate');
	let pending = $state(false);
	const today = new Date().toISOString().slice(0, 10);
	/** The person chose «another address» after the address of FSP ID turned out to be taken. */
	const otherAddress = $derived(page.url.searchParams.get('other') === '1');
	const conflict = $derived(data.fsp?.emailConflict === true && !otherAddress);

	const roles = [
		{
			value: 'candidate',
			icon: UserRoundIcon,
			title: 'Ищу работу',
			text: 'Профиль с подтверждёнными навыками; работодатели пишут первыми, с вилкой.'
		},
		{
			value: 'employer',
			icon: BriefcaseIcon,
			title: 'Нанимаю',
			text: 'Каталог кандидатов по категориям и приглашения с зарплатой — сразу после регистрации компании.'
		}
	] as const;

	function invalid(name: string): true | undefined {
		return errors[name] ? true : undefined;
	}
</script>

<AuthPage
	title={data.fsp ? 'Завершите регистрацию' : 'Регистрация'}
	description={data.fsp
		? 'Вы вошли через ФСП ID. Осталось выбрать роль и принять соглашение — учётная запись появится после этого.'
		: 'Одна учётная запись — одна роль: кандидат или работодатель.'}
>
	{#if conflict}
		<FormMessage
			tone="error"
			text="Почта из ФСП ID уже используется другой учётной записью. Автоматически мы их не связываем: так чужой ФСП ID не получит доступ к вашему аккаунту."
		/>
		<div class="grid gap-3">
			<form method="POST" action="?/discardFsp">
				<Button type="submit" size="lg" class="w-full">Войти в существующую учётную запись</Button>
			</form>
			<p class="text-sm text-muted-foreground">
				После входа привяжите ФСП ID в настройках учётной записи — понадобится ещё раз войти в ФСП ID.
			</p>
			<form method="GET">
				<input type="hidden" name="other" value="1" />
				<Button type="submit" variant="outline" size="lg" class="w-full">Зарегистрироваться с другой почтой</Button>
			</form>
		</div>
	{:else if !data.documents.userAgreement}
		<FormMessage
			tone="error"
			text="Регистрация временно недоступна: пользовательское соглашение ещё не опубликовано. Загляните позже."
		/>
	{:else}
		{#if data.demo}
			<p class="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
				Демо-стенд: учётная запись появится в вашей демо-сессии — видна только в ней и удаляется вместе с ней. Почта
				здесь считается подтверждённой, письмо не придёт.
			</p>
		{/if}
		{#if !data.fsp && data.fspEnabled}
			<p class="text-sm text-muted-foreground">
				Участвовали в соревнованиях ФСП?
				<a
					class="text-link underline underline-offset-4"
					href={resolve(SIGN_IN_HREF)}
					data-sveltekit-reload
					data-sveltekit-preload-data="off">Зарегистрируйтесь через ФСП ID</a
				> — достижения подтвердятся сами.
			</p>
		{/if}
		<form
			method="POST"
			action="?/register"
			novalidate
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update({ reset: false });
					pending = false;
				};
			}}
			class="grid gap-6"
		>
			<CsrfField viewer={data.viewer} />
			{#if form?.message}
				<FormMessage tone="error" text={form.message} />
			{:else if Object.keys(errors).length > 0}
				<FormMessage tone="error" text="Проверьте отмеченные поля" />
			{/if}

			<Field.Set>
				<Field.Legend variant="label">Роль</Field.Legend>
				<div class="grid gap-3 sm:grid-cols-2">
					{#each roles as option (option.value)}
						<label
							class="flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
						>
							<input
								type="radio"
								name="role"
								value={option.value}
								bind:group={role}
								class="mt-1 size-4 accent-primary"
							/>
							<span class="grid gap-1">
								<span class="flex items-center gap-2 font-medium">
									<option.icon class="size-4" aria-hidden="true" />
									{option.title}
								</span>
								<span class="text-sm text-muted-foreground">{option.text}</span>
							</span>
						</label>
					{/each}
				</div>
				<Field.Description>Совмещать роли кандидата и работодателя в одной учётной записи нельзя.</Field.Description>
			</Field.Set>

			<Field.Group>
				<Field.Field data-invalid={invalid('displayName')}>
					<Field.Label for="reg-name">{role === 'employer' ? 'Ваше имя' : 'Как к вам обращаться'}</Field.Label>
					<Input
						id="reg-name"
						name="displayName"
						autocomplete="name"
						required
						value={values?.displayName ?? data.fsp?.displayName ?? ''}
						aria-invalid={invalid('displayName')}
						aria-describedby={errors.displayName ? 'reg-name-error' : undefined}
					/>
					{#if errors.displayName}<Field.Error id="reg-name-error">{errors.displayName}</Field.Error>{/if}
				</Field.Field>

				<Field.Field data-invalid={invalid('email')}>
					<Field.Label for="reg-email">{role === 'employer' ? 'Рабочая почта' : 'Почта'}</Field.Label>
					<Input
						id="reg-email"
						name="email"
						type="email"
						autocomplete="email"
						required
						value={values?.email ?? data.fsp?.email ?? ''}
						aria-invalid={invalid('email')}
						aria-describedby={errors.email ? 'reg-email-error' : 'reg-email-hint'}
					/>
					{#if errors.email}
						<Field.Error id="reg-email-error">{errors.email}</Field.Error>
					{:else}
						<Field.Description id="reg-email-hint">Пришлём письмо со ссылкой для подтверждения.</Field.Description>
					{/if}
				</Field.Field>

				<Field.Field data-invalid={invalid('password')}>
					<Field.Label for="reg-password">{data.fsp ? 'Пароль (можно позже)' : 'Пароль'}</Field.Label>
					<Input
						id="reg-password"
						name="password"
						type="password"
						autocomplete="new-password"
						required={!data.fsp}
						aria-invalid={invalid('password')}
						aria-describedby={errors.password ? 'reg-password-error' : 'reg-password-hint'}
					/>
					{#if errors.password}
						<Field.Error id="reg-password-error">{errors.password}</Field.Error>
					{:else}
						<Field.Description id="reg-password-hint">
							Не короче 10 символов.{data.fsp ? ' Без пароля вы входите только через ФСП ID.' : ''}
						</Field.Description>
					{/if}
				</Field.Field>

				{#if role === 'candidate'}
					<Field.Field data-invalid={invalid('birthDate')}>
						<Field.Label for="reg-birth">Дата рождения</Field.Label>
						<Input
							id="reg-birth"
							name="birthDate"
							type="date"
							max={today}
							required
							value={values?.birthDate ?? ''}
							aria-invalid={invalid('birthDate')}
							aria-describedby={errors.birthDate ? 'reg-birth-error' : 'reg-birth-hint'}
						/>
						{#if errors.birthDate}
							<Field.Error id="reg-birth-error">{errors.birthDate}</Field.Error>
						{:else}
							<Field.Description id="reg-birth-hint">
								Работодатели её не видят. Профиль открывается с 14 лет; до 18 — в защищённом режиме с согласия законного
								представителя.
							</Field.Description>
						{/if}
					</Field.Field>
				{:else}
					<Field.Field data-invalid={invalid('companyName')}>
						<Field.Label for="reg-company">Название компании</Field.Label>
						<Input
							id="reg-company"
							name="companyName"
							autocomplete="organization"
							required
							value={values?.companyName ?? ''}
							aria-invalid={invalid('companyName')}
							aria-describedby={errors.companyName ? 'reg-company-error' : undefined}
						/>
						{#if errors.companyName}<Field.Error id="reg-company-error">{errors.companyName}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={invalid('inn')}>
						<Field.Label for="reg-inn">ИНН компании</Field.Label>
						<Input
							id="reg-inn"
							name="inn"
							inputmode="numeric"
							required
							value={values?.inn ?? ''}
							aria-invalid={invalid('inn')}
							aria-describedby={errors.inn ? 'reg-inn-error' : 'reg-inn-hint'}
						/>
						{#if errors.inn}
							<Field.Error id="reg-inn-error">{errors.inn}</Field.Error>
						{:else}
							<Field.Description id="reg-inn-hint">
								Работать с кандидатами можно сразу. Проверка оператором ФСП необязательна: она снимает метку «компания
								не проверена» в предложениях кандидатам.
							</Field.Description>
						{/if}
					</Field.Field>
				{/if}
			</Field.Group>

			<Field.Set>
				<Field.Legend variant="label">Документы</Field.Legend>
				<input type="hidden" name="userAgreementId" value={data.documents.userAgreement.id} />
				<label class="flex items-start gap-3 text-sm">
					<input type="checkbox" name="userAgreement" required class="mt-0.5 size-4 accent-primary" />
					<span>
						Принимаю
						<a
							class="text-link underline underline-offset-4"
							href={resolve('/(auth)/documents/[kind]', { kind: 'user_agreement' })}
							target="_blank"
							rel="noopener">{data.documents.userAgreement.title}</a
						>
						(редакция {data.documents.userAgreement.version})
					</span>
				</label>
				{#if role === 'employer'}
					{#if data.documents.employerTerms}
						<input type="hidden" name="employerTermsId" value={data.documents.employerTerms.id} />
						<label class="flex items-start gap-3 text-sm">
							<input type="checkbox" name="employerTerms" required class="mt-0.5 size-4 accent-primary" />
							<span>
								Принимаю от имени компании
								<a
									class="text-link underline underline-offset-4"
									href={resolve('/(auth)/documents/[kind]', { kind: 'employer_terms' })}
									target="_blank"
									rel="noopener">{data.documents.employerTerms.title}</a
								>
								(редакция {data.documents.employerTerms.version})
							</span>
						</label>
					{:else}
						<FormMessage
							tone="error"
							text="Регистрация работодателей временно недоступна: условия для работодателя ещё не опубликованы."
						/>
					{/if}
				{:else}
					<Field.Description>
						Согласие на обработку персональных данных — следующим шагом, на отдельной странице.
					</Field.Description>
				{/if}
				{#if errors.documents}<Field.Error>{errors.documents}</Field.Error>{/if}
			</Field.Set>

			<Button type="submit" size="lg" disabled={pending}>Зарегистрироваться</Button>
		</form>
	{/if}

	{#snippet footer()}
		<span>Уже есть учётная запись?</span>
		<a class="text-link underline underline-offset-4" href={resolve(LOGIN_HREF)}>Войти</a>
	{/snippet}
</AuthPage>
