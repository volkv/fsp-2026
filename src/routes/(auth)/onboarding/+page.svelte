<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { ACCOUNT_HREF } from '$lib/navigation.js';
	import AuthPage from '../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import OnboardingStep from './onboarding-step.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const state = $derived(data.state);
	const candidate = $derived(state.candidate);
	const dateFormat = new Intl.DateTimeFormat('ru-RU', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const formatDate = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));

	const REPRESENTATIVE_STATUS: Record<NonNullable<NonNullable<typeof candidate>['representative']>, string> = {
		ended: 'Полномочия представителя прекращены — укажите представителя снова',
		invited: 'Письмо представителю отправлено — ждём подтверждения адреса',
		contact_confirmed: 'Представитель подтвердил адрес; оператор ФСП проверит полномочия',
		authority_pending: 'Оператор ФСП проверяет полномочия представителя',
		authority_verified: 'Полномочия представителя подтверждены'
	};
</script>

<AuthPage
	title="Шаги регистрации"
	description={state.complete
		? 'Регистрация завершена. Категория появится после теста на заявленный грейд.'
		: 'Осталось несколько шагов. Опрос и грейд открываются после согласия на обработку профиля.'}
>
	{#if data.letterFailed}
		<FormMessage
			tone="error"
			text="Письмо с подтверждением не ушло: почтовый сервер недоступен. Отправьте его ещё раз."
		/>
	{/if}
	{#if data.representativeSent === 'not_sent'}
		<FormMessage
			tone="error"
			text="Заявка на представителя сохранена, но письмо ему не ушло: почтовый сервер недоступен."
		/>
	{/if}
	{#if form?.message}
		<FormMessage tone="error" text={form.message} />
	{/if}

	<section class="grid gap-3" data-step="email" data-done={state.emailVerified}>
		<OnboardingStep
			done={state.emailVerified}
			title="Почта"
			text={state.emailVerified ? 'Адрес подтверждён.' : 'Откройте письмо со ссылкой — ссылка действует 24 часа.'}
		/>
		{#if !state.emailVerified}
			<form method="POST" action="?/resend" use:enhance class="pl-8">
				<CsrfField viewer={data.viewer} />
				<Button type="submit" variant="outline" size="sm">Отправить письмо ещё раз</Button>
			</form>
			{#if form && 'resent' in form}
				<p class="pl-8 text-sm text-muted-foreground" role="status">Письмо отправлено.</p>
			{/if}
		{/if}
	</section>

	{#if candidate}
		{#if candidate.status === 'ineligible_age' && candidate.eligibleFrom}
			<section class="grid gap-3" data-step="age">
				<FormMessage
					tone="error"
					text="Профиль соискателя открывается с 14 лет. Учётная запись сохранена: вернитесь с {formatDate(
						candidate.eligibleFrom
					)}."
				/>
				{#if candidate.eligibleFrom <= data.today}
					<form method="POST" action="?/birthDate" use:enhance class="grid gap-3">
						<CsrfField viewer={data.viewer} />
						<Field.Field>
							<Field.Label for="onb-birth">Дата рождения</Field.Label>
							<Input id="onb-birth" name="birthDate" type="date" max={data.today} required />
						</Field.Field>
						<Button type="submit">Продолжить</Button>
					</form>
				{/if}
			</section>
		{:else}
			<section class="grid gap-3" data-step="consent" data-done={candidate.profileConsent}>
				<OnboardingStep
					done={candidate.profileConsent}
					title="Согласие на обработку профиля"
					text={candidate.profileConsent
						? 'Согласие дано. Отозвать его можно в любой момент.'
						: 'Без него профиль не ведётся: категоризация и подбор работают только по согласию.'}
				/>
				{#if !candidate.profileConsent}
					<a href={resolve('/onboarding/consent')} class="{buttonVariants({ size: 'sm' })} ml-8 justify-self-start">
						Прочитать и дать согласие
					</a>
				{/if}
			</section>
			{#if candidate.minor}
				<section class="grid gap-3" data-step="representative" data-done={candidate.representative !== null}>
					<OnboardingStep
						done={candidate.representative !== null}
						title="Законный представитель"
						text={candidate.representative
							? REPRESENTATIVE_STATUS[candidate.representative]
							: 'До 18 лет профиль открывается с согласия родителя или другого законного представителя. Пока его нет, работодатели профиль не видят.'}
					/>
					{#if candidate.representative === null && candidate.status === 'active'}
						<a
							href={resolve('/onboarding/representative')}
							class="{buttonVariants({ size: 'sm' })} ml-8 justify-self-start"
						>
							Указать представителя
						</a>
					{/if}
				</section>
			{/if}
			<section class="grid gap-3" data-step="survey" data-done={candidate.survey !== null}>
				<OnboardingStep
					done={candidate.survey !== null}
					title="Опрос"
					text={candidate.survey
						? `Пройден: ${data.specializationTitles[candidate.survey.specialization]}.`
						: 'Направление, специализация, стек и формат работы — по ним строится подсказка грейда и тест.'}
				/>
				{#if candidate.status === 'active'}
					<a
						href={resolve('/onboarding/survey')}
						class="{buttonVariants({
							size: 'sm',
							variant: candidate.survey ? 'outline' : 'default'
						})} ml-8 justify-self-start"
					>
						{candidate.survey ? 'Пройти заново' : 'Пройти опрос'}
					</a>
				{:else}
					<p class="pl-8 text-sm text-muted-foreground">Откроется после согласия на обработку профиля.</p>
				{/if}
			</section>
			<section class="grid gap-3" data-step="grade" data-done={candidate.declaredGrade !== null}>
				<OnboardingStep
					done={candidate.declaredGrade !== null}
					title="Заявленный грейд"
					text={candidate.declaredGrade
						? `Заявлен: ${data.gradeTitles[candidate.declaredGrade]}. Дальше — тест на этот грейд.`
						: 'Подсказка по резюме, ФСП и публичным профилям советует грейд, заявляете вы. Без теста категории нет.'}
				/>
				{#if candidate.survey}
					<div class="ml-8 flex flex-wrap gap-2">
						<a
							href={resolve('/onboarding/grade')}
							class={buttonVariants({ size: 'sm', variant: candidate.declaredGrade ? 'outline' : 'default' })}
						>
							{candidate.declaredGrade ? 'Изменить грейд' : 'Заявить грейд'}
						</a>
						{#if candidate.declaredGrade}
							<a href={resolve('/me/tests')} class={buttonVariants({ size: 'sm' })}>Перейти к тесту</a>
						{/if}
					</div>
				{/if}
			</section>
		{/if}
	{:else if state.company}
		<section class="grid gap-3" data-step="company">
			<OnboardingStep
				done={true}
				title={`Компания «${state.company.displayName}»`}
				text="Каталог кандидатов, вакансии и предложения открыты и без проверки компании; кандидаты видят в предложениях метку «компания не проверена». Проверка оператором ФСП по ИНН и полномочиям заявителя необязательна, заявка на неё — в профиле компании."
			/>
		</section>
	{/if}

	{#snippet footer()}
		<a class="text-link underline underline-offset-4" href={resolve(ACCOUNT_HREF)}>Учётная запись и вход</a>
	{/snippet}
</AuthPage>
