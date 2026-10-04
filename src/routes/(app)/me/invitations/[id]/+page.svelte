<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { onMount } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import HiringPanel from '$lib/components/candidate/hiring-panel.svelte';
	import {
		DISCLOSURE_FIELDS,
		gradeName,
		reasonText,
		REQUIRED_DISCLOSURE,
		roleName,
		skillName,
		type DisclosureField
	} from '$lib/components/candidate/model.js';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import TermsChanges from '$lib/components/candidate/terms-changes.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { InvitationStatus, ResponseDeadline, SalaryRange } from '$lib/components/product/index.js';
	import { formatDate, formatDateTime, type SalaryComparison } from '$lib/components/product/model.js';
	import { CSRF_FIELD, viewerFrom } from '$lib/components/shell/viewer.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const card = $derived(data.card);
	const invitation = $derived(card.invitation);
	const labels = $derived(card.labels);
	const current = $derived(invitation.versions.find((version) => version.id === invitation.currentTermsId));
	const accepted = $derived(invitation.versions.find((version) => version.id === invitation.acceptedTermsId) ?? null);
	const shown = $derived(current ?? invitation.versions.at(-1));
	const now = Date.now();
	const awaiting = $derived(invitation.awaitingRepresentative);
	const answerable = $derived(
		current !== undefined &&
			awaiting === null &&
			current.response === null &&
			current.responseDueAt.getTime() > now &&
			(invitation.status === 'sent' || invitation.status === 'viewed' || invitation.status === 'accepted')
	);
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const optionalFields = (Object.keys(DISCLOSURE_FIELDS) as DisclosureField[]).filter(
		(field) => !REQUIRED_DISCLOSURE.includes(field) && field !== 'resume'
	);

	const COMPARISON: Record<SalaryComparison, string> = {
		lower: 'ниже этого предложения',
		equal: 'как в этом предложении',
		higher: 'выше этого предложения',
		overlap: 'пересекается с этим предложением',
		not_comparable: 'несравнимо: другие валюта, период или налоговая база'
	};

	const selectClass =
		'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

	function range(min: string | null, max: string | null): string {
		if (min === null || max === null) return 'не указан';
		return min === max ? gradeName(labels, min) : `${gradeName(labels, min)} – ${gradeName(labels, max)}`;
	}

	// Opening the invitation in the browser marks it viewed; a preload of the link on hover does not.
	onMount(() => {
		if (invitation.status !== 'sent') return;
		const viewer = viewerFrom(page.data);
		if (!viewer) return;
		const body = new FormData();
		body.set(CSRF_FIELD, viewer.csrfToken);
		void fetch('?/viewed', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } }).then(
			async (response) => {
				const result = deserialize(await response.text());
				if (result.type === 'success') await invalidateAll();
			}
		);
	});
</script>

<PageHeader title={shown?.vacancy.title ?? 'Приглашение'} description={invitation.companyName}>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/invitations')}>Приглашения</a
		>{/snippet}
	{#snippet actions()}
		<InvitationStatus status={invitation.status} />
	{/snippet}
</PageHeader>

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'accepted' in form}
	<FormMessage
		tone="success"
		text="Приглашение принято. Компания получила выбранные контакты — дальше процесс найма."
	/>
{:else if form && 'awaitingRepresentative' in form}
	<FormMessage
		tone="success"
		text={form.letterSent
			? 'Ты принял приглашение. Законному представителю ушло письмо: контакты компания получит, когда он согласится.'
			: 'Ты принял приглашение, но письмо представителю не ушло — отправь его ещё раз ниже.'}
	/>
{:else if form && 'letterResent' in form}
	<FormMessage tone="success" text="Письмо законному представителю отправлено ещё раз." />
{:else if form && 'declined' in form}
	<FormMessage tone="success" text="Ответ отправлен: приглашение отклонено." />
{:else if form && 'disclosureRevoked' in form}
	<FormMessage
		tone="success"
		text={invitation.status === 'accepted'
			? 'Согласие на раскрытие отозвано.'
			: 'Принятие отменено: представитель больше не может ответить по ссылке, контакты не передаются.'}
	/>
{:else if form && 'reported' in form}
	<FormMessage tone="success" text="Сообщение о найме сохранено." />
{/if}

{#if shown}
	<SectionCard
		title="Условия{shown.version > 1 ? ` · версия ${shown.version}` : ''}"
		description="Отправлено {formatDateTime(
			shown.createdAt
		)}. Отправленные условия неизменны: пересмотр — новая версия, которую ты принимаешь отдельно."
		testId="invitation-terms"
	>
		<div class="flex flex-wrap items-center justify-between gap-4">
			<SalaryRange salary={shown.salary} size="lg" />
			{#if answerable && current}
				<ResponseDeadline dueAt={current.responseDueAt} />
			{/if}
		</div>
		<dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Роль:</dt>
				<dd>{shown.vacancy.role_key ? roleName(labels, shown.vacancy.role_key) : 'не указана'}</dd>
			</div>
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Грейд:</dt>
				<dd>{range(shown.vacancy.grade_min, shown.vacancy.grade_max)}</dd>
			</div>
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Формат:</dt>
				<dd>
					{shown.vacancy.work_format
						? (labels.workFormats[shown.vacancy.work_format] ?? shown.vacancy.work_format)
						: 'не указан'}
				</dd>
			</div>
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Занятость:</dt>
				<dd>
					{shown.vacancy.employment_form
						? (labels.employmentForms[shown.vacancy.employment_form] ?? shown.vacancy.employment_form)
						: 'не указана'}
				</dd>
			</div>
			<div class="flex gap-1.5 sm:col-span-2">
				<dt class="text-muted-foreground">Обязательные навыки:</dt>
				<dd>{shown.vacancy.required_skill_keys.map((key) => skillName(labels, key)).join(', ') || 'не указаны'}</dd>
			</div>
			{#if shown.vacancy.nice_skill_keys.length > 0}
				<div class="flex gap-1.5 sm:col-span-2">
					<dt class="text-muted-foreground">Желательные:</dt>
					<dd>{shown.vacancy.nice_skill_keys.map((key) => skillName(labels, key)).join(', ')}</dd>
				</div>
			{/if}
		</dl>
		{#if shown.message}
			<blockquote class="border-l-2 pl-3 text-sm whitespace-pre-line">{shown.message}</blockquote>
		{/if}
		{#if shown.changes}
			<div class="grid gap-2 rounded-lg border p-3">
				<h3 class="text-sm font-semibold">Что изменилось по сравнению с версией {shown.changes.previous_version}</h3>
				<TermsChanges changes={shown.changes} {labels} />
			</div>
		{/if}
		{#if accepted && current && accepted.id !== current.id}
			<p class="rounded-lg bg-info-subtle p-3 text-sm text-info">
				Ты принял версию {accepted.version}; она остаётся принятой, пока ты не ответишь на новую.
			</p>
		{/if}
	</SectionCard>
{/if}

{#if awaiting}
	<SectionCard
		title="Ждём согласия законного представителя"
		description="До 18 лет контакты передаются компании, только когда согласие дал и законный представитель. Письмо со ссылкой ушло ему на почту."
		testId="awaiting-representative"
	>
		<p class="text-sm">
			Ты принял приглашение {formatDateTime(awaiting.requestedAt)}. Представитель должен ответить до
			<span class="font-medium">{formatDateTime(awaiting.dueAt)}</span> — это срок ответа на приглашение; без его согласия
			приглашение закроется.
		</p>
		{#if awaiting.fields}
			<p class="text-sm">
				Компания получит: {awaiting.fields.map((field) => DISCLOSURE_FIELDS[field]).join(', ')}.
			</p>
		{/if}
		<div class="flex flex-wrap gap-3">
			<form method="POST" action="?/resendRepresentative" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="outline" size="sm">Отправить письмо ещё раз</Button>
			</form>
			<form method="POST" action="?/revokeDisclosure" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="ghost" size="sm">Отменить принятие</Button>
			</form>
		</div>
	</SectionCard>
{:else if answerable && current}
	<div class="grid gap-4 lg:grid-cols-2" data-testid="invitation-answer">
		<SectionCard
			title="Принять"
			description="Контакты получит только эта компания и только выбранные. Раскрытие фиксируется в журнале; согласие можно отозвать."
		>
			{#if card.disclosureDocument}
				<form method="POST" action="?/accept" use:enhance class="grid gap-4">
					<CsrfInput />
					<input type="hidden" name="termsId" value={current.id} />
					<input type="hidden" name="disclosureDocumentId" value={card.disclosureDocument.id} />
					<fieldset class="grid gap-2">
						<legend class="mb-1 text-sm font-medium">Что раскрыть компании</legend>
						{#each REQUIRED_DISCLOSURE as field (field)}
							<input type="hidden" name="disclose_fields" value={field} />
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" checked disabled class="size-4 accent-primary" />
								{DISCLOSURE_FIELDS[field]} <span class="text-xs text-muted-foreground">— обязательно</span>
							</label>
						{/each}
						{#each optionalFields as field (field)}
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									name="disclose_fields"
									value={field}
									class="size-4 accent-primary"
									disabled={field === 'phone' && !card.hasPhone}
									checked={card.disclosedFields.includes(field)}
								/>
								{DISCLOSURE_FIELDS[field]}
								{#if field === 'phone' && !card.hasPhone}
									<span class="text-xs text-muted-foreground">— не указан в профиле</span>
								{/if}
							</label>
						{/each}
					</fieldset>
					<details class="rounded-lg border text-sm">
						<summary class="cursor-pointer px-3 py-2 font-medium">
							{card.disclosureDocument.title} · редакция {card.disclosureDocument.version}
						</summary>
						<div class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line" data-testid="disclosure-consent-text">
							{card.disclosureDocument.body}
						</div>
					</details>
					<Button type="submit" class="justify-self-start">
						<CheckIcon aria-hidden="true" />
						Принять и раскрыть выбранное
					</Button>
				</form>
			{:else}
				<p class="text-sm text-muted-foreground">
					Текст согласия на раскрытие контактов не опубликован — принять приглашение сейчас нельзя.
				</p>
			{/if}
		</SectionCard>

		<SectionCard title="Отклонить" description="Компания увидит причину из списка; комментарий — по желанию.">
			<form method="POST" action="?/decline" use:enhance class="grid gap-4">
				<CsrfInput />
				<input type="hidden" name="termsId" value={current.id} />
				<label class="grid gap-1.5 text-sm">
					<span>Причина</span>
					<select name="reason_code" class={selectClass} required={card.decline.reasonRequired}>
						<option value="">{card.decline.reasonRequired ? '— выбери —' : '— не указывать —'}</option>
						{#each card.decline.reasonCodes as code (code)}
							<option value={code}>{reasonText(code)}</option>
						{/each}
					</select>
				</label>
				<label class="grid gap-1.5 text-sm">
					<span>Комментарий</span>
					<Textarea name="reason_text" maxlength={2000} rows={3} />
				</label>
				<Button type="submit" variant="outline" class="justify-self-start">
					<XIcon aria-hidden="true" />
					Отклонить
				</Button>
			</form>
		</SectionCard>
	</div>
{:else if current && current.response === null && (invitation.status === 'sent' || invitation.status === 'viewed')}
	<p class="text-sm text-muted-foreground">Срок ответа на эту версию прошёл.</p>
{/if}

{#if invitation.status === 'accepted'}
	<SectionCard
		title="Раскрытые контакты"
		description="Отзыв закрывает компании доступ к твоей карточке получателя сразу. Уже переданные контакты остаются у компании — так сказано в тексте согласия."
		testId="disclosure"
	>
		{#if card.disclosedFields.length > 0}
			<p class="text-sm">
				Компания получает: {card.disclosedFields.map((field) => DISCLOSURE_FIELDS[field]).join(', ')}.
			</p>
			<form method="POST" action="?/revokeDisclosure" use:enhance>
				<CsrfInput />
				<Button type="submit" variant="outline" size="sm">Отозвать согласие на раскрытие</Button>
			</form>
		{:else}
			<p class="text-sm text-muted-foreground">
				Согласие на раскрытие отозвано: компания больше не видит твои контакты.
			</p>
		{/if}
	</SectionCard>
{/if}

{#if card.process && card.hiringPolicy}
	<SectionCard
		title="Процесс найма"
		description="Собеседование, предложение, выход. Исход отмечает каждая сторона."
		testId="hiring"
	>
		<HiringPanel
			process={card.process}
			stages={card.hiringPolicy.stages}
			outcomeReasonCodes={card.hiringPolicy.outcomeReasonCodes}
		/>
	</SectionCard>
{/if}

{#if invitation.versions.length > 1}
	<SectionCard title="История версий" description="Каждая версия условий хранится неизменной вместе с твоим ответом.">
		<ol class="grid gap-2 text-sm">
			{#each [...invitation.versions].reverse() as version (version.id)}
				<li class="grid gap-1 rounded-lg border p-3">
					<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
						<span class="font-medium">Версия {version.version}</span>
						<span class="text-muted-foreground">{formatDate(version.createdAt)}</span>
						<SalaryRange salary={version.salary} />
					</span>
					<span class="text-muted-foreground">
						{#if version.response}
							{version.response.decision === 'accept' ? 'Принята' : 'Отклонена'}
							{formatDate(version.response.respondedAt)}{version.response.reasonCode
								? ` · ${reasonText(version.response.reasonCode)}`
								: ''}
						{:else if version.id === invitation.currentTermsId}
							Ждёт ответа
						{:else}
							Заменена новой версией без ответа
						{/if}
					</span>
				</li>
			{/each}
		</ol>
	</SectionCard>
{/if}

{#if invitation.otherOffers.length > 0}
	<SectionCard
		title="Другие предложения этой компании"
		description="Сравнение вилок — только при одинаковых валюте, периоде и налоговой базе."
	>
		<ul class="grid gap-2 text-sm">
			{#each invitation.otherOffers as offer (offer.invitationId)}
				<li class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<a
						class="text-link underline underline-offset-4"
						href={resolve('/(app)/me/invitations/[id]', { id: offer.invitationId })}>{offer.vacancyTitle}</a
					>
					<SalaryRange salary={offer.salary} />
					<span class="text-muted-foreground">{COMPARISON[offer.comparison]}</span>
				</li>
			{/each}
		</ul>
	</SectionCard>
{/if}
