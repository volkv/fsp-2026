<script lang="ts">
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import MailIcon from '@lucide/svelte/icons/mail';
	import UserPlusIcon from '@lucide/svelte/icons/user-plus';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { termText, timeLeft } from '$lib/components/shell/viewer.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import AuthPage from '../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let pending = $state<string | null>(null);

	const GROUPS = [
		{ key: 'employer', title: 'Работодатели', hint: 'Каталог кандидатов, вакансии, приглашения и найм.' },
		{ key: 'candidate', title: 'Кандидаты', hint: 'Профиль с доказательствами, категория, приглашения.' },
		{ key: 'staff', title: 'Персонал', hint: 'Оператор ФСП и администратор платформы.' }
	] as const;
</script>

<AuthPage
	title="Демо-сессия"
	description="Выберите, за кого пройти сценарий. Для вас создаётся своя копия героев, компаний и их данных: ваши приглашения, ответы, найм и возражения не видны другим посетителям, и их действия не меняют вашу копию."
	width="wide"
>
	{#if !data.seeded}
		<FormMessage tone="error" text="Демо-данные стенда ещё засеваются. Обновите страницу через несколько минут." />
	{:else}
		{#if form?.message}
			<FormMessage tone="error" text={form.message} />
		{/if}
		{#if data.joining === 'expired'}
			<FormMessage tone="error" text="Ссылка на демо-сессию устарела: её время закончилось. Можно начать новую." />
		{/if}
		{#if data.fspNotice}
			<FormMessage tone="error" text={data.fspNotice} />
		{/if}

		<section
			aria-labelledby="demo-terms-heading"
			class="grid gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-4 text-sm"
			data-testid="demo-terms"
		>
			<h2 id="demo-terms-heading" class="font-medium">
				{data.terms.review ? 'Стенд в режиме экспертизы' : 'Сколько живёт демо-сессия'}
			</h2>
			<p>
				Сессия живёт {termText(data.terms.idleMinutes)} после последнего действия в ней и не дольше {termText(
					data.terms.sessionHours * 60
				)} от открытия{#if data.resetAt}; ночной сброс стенда удаляет все сессии{/if}. Потом она удаляется целиком:
				роли, учётки, которые вы в ней зарегистрировали, всё сделанное и загруженное резюме — вернуть их нельзя.
				{#if data.terms.review}Возвращайтесь в ту же сессию по её ссылке: каждый заход снова даёт {termText(
						data.terms.idleMinutes
					)}.{/if}
			</p>
			<p>
				Это демонстрационный стенд: регистрируйтесь с вымышленными данными и загружайте только синтетическое или
				обезличенное резюме. Письмо подтверждения почты зарегистрированной учётки приходит в «Письма сессии».
			</p>
		</section>

		{#if data.session}
			<section
				aria-labelledby="demo-session-heading"
				class="grid gap-3 rounded-lg border p-4"
				data-testid="demo-session"
			>
				<h2 id="demo-session-heading" class="font-heading text-h3">Ваша демо-сессия</h2>
				<p class="text-sm">
					Удалится через <strong data-testid="demo-remaining">{timeLeft(data.session.idleEndsAt, Date.now())}</strong>,
					если в неё не заходить: каждое действие в сессии и каждый заход на эту страницу снова дают {termText(
						data.terms.idleMinutes
					)}. В любом случае сессия удалится {data.session.endsAtReset
						? 'при ночном сбросе стенда'
						: 'в конце своего срока'}
					{formatDateTime(data.session.endsAt)} — вместе со всем, что в ней сделано{#if data.session.ownResumeAt}, и
						вашим резюме{/if}. Потом можно начать новую, но сделанное в этой не вернуть.
				</p>
				<p class="text-sm text-muted-foreground">
					Когда на стенде заняты все {data.maxSessions} мест, новый посетитель получает место сессии, в которую дольше всех
					не заходили, — если в неё не заходили хотя бы {termText(data.terms.evictableMinutes)}.
				</p>
				<div class="grid gap-1">
					<label for="demo-join-link" class="text-sm text-muted-foreground">
						Ссылка, чтобы открыть эту же сессию в другом браузере (например, работодатель и кандидат рядом):
					</label>
					<Input id="demo-join-link" readonly value={data.session.joinLink} class="font-mono text-xs" />
				</div>
				<div class="grid gap-2 rounded-lg border border-dashed p-3" data-testid="demo-newcomer">
					<p class="text-sm">
						<strong>Новый кандидат в этой сессии</strong> — чистая учётка без профиля: согласие, опрос, заявленный грейд и
						тест с первого задания. Работодатели этой сессии найдут его по категории, которую даст тест. В демо-сессии порядок
						грейдов и интервалы политики отключены: можно сразу пройти Junior и Senior и повторить тот же грейд.
					</p>
					<form
						method="POST"
						action="?/newcomer"
						use:enhance={() => {
							pending = 'newcomer';
							return async ({ update }) => {
								await update({ reset: false });
								pending = null;
							};
						}}
					>
						<CsrfField viewer={data.viewer} />
						<input type="hidden" name="join" value={data.session.token} />
						<Button type="submit" variant="secondary" disabled={pending !== null}>
							<UserPlusIcon aria-hidden="true" />
							{pending === 'newcomer' ? 'Создаём кандидата…' : 'Новый кандидат в этой сессии'}
						</Button>
					</form>
					<p class="text-xs text-muted-foreground">
						Браузер войдёт под новым кандидатом. Работодателя этой же сессии держите в другом профиле браузера — по
						ссылке выше. Нажимая, вы принимаете пользовательское соглашение стенда от имени вымышленного кандидата.
					</p>
				</div>
				<div class="flex flex-wrap gap-3">
					<a href={resolve('/demo/resume')} class={buttonVariants({ variant: 'outline' })}>
						<FileUpIcon aria-hidden="true" />
						Загрузить своё резюме
					</a>
					<a href={resolve('/demo/mail')} class={buttonVariants({ variant: 'outline' })}>
						<MailIcon aria-hidden="true" />
						Письма сессии
					</a>
					<form method="POST" action="?/leave">
						<CsrfField viewer={data.viewer} />
						<Button type="submit" variant="ghost">Закончить и начать новую</Button>
					</form>
				</div>
			</section>
		{/if}

		{#each GROUPS as group (group.key)}
			{@const roles = data.roles.filter((role) => role.group === group.key)}
			<section aria-labelledby="demo-group-{group.key}" class="grid gap-3">
				<div class="grid gap-1">
					<h2 id="demo-group-{group.key}" class="font-heading text-h3">{group.title}</h2>
					<p class="text-sm text-muted-foreground">{group.hint}</p>
				</div>
				<ul class="grid gap-2">
					{#each roles as role (role.key)}
						<li class="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3" data-role={role.key}>
							<div class="grid gap-0.5">
								<p class="flex flex-wrap items-center gap-2 font-medium">
									{#if role.code}<Badge variant="secondary">{role.code}</Badge>{/if}
									{role.name}
									{#if data.session?.role === role.key}<Badge variant="outline">вы здесь</Badge>{/if}
								</p>
								<p class="text-sm text-muted-foreground">{role.part}</p>
							</div>
							<form
								method="POST"
								action="?/enter"
								use:enhance={() => {
									pending = role.key;
									return async ({ update }) => {
										await update({ reset: false });
										pending = null;
									};
								}}
							>
								<CsrfField viewer={data.viewer} />
								<input type="hidden" name="role" value={role.key} />
								{#if data.session}
									<input type="hidden" name="join" value={data.session.token} />
								{/if}
								<Button type="submit" disabled={pending !== null} aria-label="Войти: {role.name}">
									<LogInIcon aria-hidden="true" />
									{pending === role.key ? 'Готовим копию…' : 'Войти'}
								</Button>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}

	{#snippet footer()}
		<span
			>Люди и компании вымышленные, соревнования — реальные соревнования ФСП. Стенд возвращается к исходным данным
			{#if data.resetAt}каждую ночь, ближайший раз — {formatDateTime(data.resetAt)}: все демо-сессии удаляются.{:else}при
				смене партии демо-данных: все демо-сессии удаляются.{/if}</span
		>
	{/snippet}
</AuthPage>
