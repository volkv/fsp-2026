<script lang="ts">
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10">
	<PageHeader
		title={data.cause === 'processing_revoked' ? 'Отзыв согласия и удаление профиля' : 'Удаление учётной записи'}
		description={data.candidate
			? 'Без согласия на обработку персональных данных профиль не ведётся: отзыв согласия и удаление учётной записи — одно действие.'
			: 'Удаление закрывает вход и завершает участие в команде компании.'}
	>
		{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/account')}>Учётная запись</a>{/snippet}
	</PageHeader>

	{#if form?.message}
		<FormMessage text={form.message} />
	{/if}

	<SectionCard title="Что произойдёт" testId="deletion-effects">
		<ul class="grid list-disc gap-1 pl-5 text-sm">
			<li>Вход закрывается сразу, все сеансы завершаются.</li>
			{#if data.candidate}
				<li>
					Профиль сразу исчезает из каталога и подборов, неотвеченные приглашения отзываются, согласия перестают
					действовать.
				</li>
				<li>
					В течение 30 дней стираются анкета, резюме и файлы, достижения, результаты тестов, категории, соответствия
					вакансиям и уведомления.
				</li>
			{:else}
				<li>Участие в команде компании завершается, созданные вами ключи API отзываются.</li>
				<li>В течение 30 дней стираются почта, имя, пароль, уведомления и способы входа.</li>
			{/if}
		</ul>
	</SectionCard>

	<SectionCard title="Что останется" testId="deletion-kept">
		<ul class="grid list-disc gap-1 pl-5 text-sm">
			<li>Журнал действий — только идентификаторы и коды, без имени и почты; хранится по правилам журнала.</li>
			{#if data.candidate}
				<li>
					Сведения о том, каким компаниям и какие контакты вы передали, — как доказательство законности передачи, без
					имени и контактов, на срок хранения.
				</li>
				{#if data.companiesWithContacts > 0}
					<li data-testid="deletion-disclosed">
						Контакты, которые вы уже передали компаниям ({data.companiesWithContacts}), остаются у них: компании
						обрабатывают их самостоятельно, отозвать их через платформу нельзя.
					</li>
				{/if}
			{/if}
		</ul>
		{#if data.candidate}
			<p class="text-sm text-muted-foreground">
				Перед удалением можно <a class="text-link underline underline-offset-4" href={resolve('/me/export')}
					>скачать свои данные</a
				>.
			</p>
		{/if}
	</SectionCard>

	<SectionCard title="Подтверждение" testId="deletion-confirm">
		{#if data.staff}
			<p class="text-sm" data-testid="deletion-staff">
				У учётной записи есть роль сотрудника платформы: сначала администратор снимает роль, затем учётную запись можно
				удалить.
			</p>
		{:else if data.membership?.role === 'owner'}
			<p class="text-sm" data-testid="deletion-owner">
				Если вы единственный владелец компании «{data.membership.companyName}», сначала передайте владение другому
				участнику команды — компания не остаётся без владельца.
			</p>
		{/if}
		{#if data.freshAuth}
			<form method="POST" use:enhance class="grid gap-4">
				<CsrfInput />
				<input type="hidden" name="cause" value={data.cause} />
				<div class="grid gap-1 text-sm">
					<label for="deletion-reason">Причина (необязательно)</label>
					<Input id="deletion-reason" name="reason" maxlength={500} autocomplete="off" />
				</div>
				<label class="flex items-start gap-2 text-sm">
					<input type="checkbox" name="confirm" value="yes" required class="mt-1 size-4" />
					<span>Понимаю, что учётную запись и данные нельзя будет восстановить.</span>
				</label>
				<Button type="submit" variant="destructive" class="justify-self-start" disabled={data.staff}>
					<TrashIcon aria-hidden="true" />
					{data.candidate ? 'Отозвать согласие и удалить' : 'Удалить учётную запись'}
				</Button>
			</form>
		{:else}
			<p class="text-sm">Удаление требует свежего входа: подтвердите, что это вы.</p>
			<a
				class="{buttonVariants({ variant: 'outline' })} justify-self-start"
				href="{resolve('/account/reauth')}?returnTo={encodeURIComponent(data.returnTo)}">Подтвердить вход</a
			>
		{/if}
	</SectionCard>
</div>
