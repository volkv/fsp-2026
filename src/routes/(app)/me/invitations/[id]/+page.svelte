<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { onMount } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import HiringPanel from '$lib/components/candidate/hiring-panel.svelte';
	import OfferConversation from '$lib/components/product/offer-conversation.svelte';
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
	import { InvitationStatus, ResponseDeadline, SalaryRange, TrustFacts } from '$lib/components/product/index.js';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
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
	const complaint = $derived(data.complaint);

	const COMPLAINT_REASONS = {
		terms_mismatch: 'Условия на деле не совпали с предложением (на собеседовании назвали другое)',
		no_real_job: 'Работы, которую описывает предложение, нет',
		contact_harvesting: 'Предложение использовали, чтобы получить мои контакты',
		payment_demanded: 'Требовали оплату: обучение, оформление, оборудование',
		discrimination: 'Дискриминирующие требования или вопросы',
		other: 'Другое'
	} as const;
	const COMPLAINT_DECISIONS = {
		no_action: 'оснований для мер не найдено',
		warning: 'компании вынесено предупреждение',
		suspension: 'работа компании на платформе приостановлена'
	} as const;
	const optionalFields = (Object.keys(DISCLOSURE_FIELDS) as DisclosureField[]).filter(
		(field) => !REQUIRED_DISCLOSURE.includes(field) && field !== 'resume'
	);

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

<PageHeader title={shown?.title ?? 'Приглашение'} description={invitation.company.displayName}>
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
		text="Приглашение принято: компания получила выбранные контакты, открылась переписка с ней. Это согласие пообщаться, а не принятие оффера."
	/>
{:else if form && 'awaitingRepresentative' in form}
	<FormMessage
		tone="success"
		text={form.letterSent
			? 'Вы приняли приглашение. Законному представителю ушло письмо: контакты компания получит, когда он согласится.'
			: 'Вы приняли приглашение, но письмо представителю не ушло — отправьте его ещё раз ниже.'}
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
{:else if form && 'complained' in form}
	<FormMessage
		tone="success"
		text="Жалоба отправлена оператору ФСП. Компания не узнает, кто пожаловался; решение придёт уведомлением."
	/>
{/if}

{#if shown}
	<SectionCard
		title="Условия{shown.version > 1 ? ` · версия ${shown.version}` : ''}"
		description="Отправлено {formatDateTime(
			shown.createdAt
		)}. Отправленные условия неизменны: пересмотр — новая версия, которую вы принимаете отдельно."
		testId="invitation-terms"
	>
		<div class="flex flex-wrap items-center justify-between gap-4">
			<SalaryRange salary={shown.salary} size="lg" />
			{#if answerable && current}
				<ResponseDeadline dueAt={current.responseDueAt} />
			{/if}
		</div>
		<p class="text-sm whitespace-pre-line">{shown.description}</p>
		<dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Формат:</dt>
				<dd>{labels.workFormats[shown.workFormat] ?? shown.workFormat}</dd>
			</div>
			<div class="flex gap-1.5">
				<dt class="text-muted-foreground">Связь с компанией:</dt>
				<dd data-testid="offer-contact">
					{shown.contactMethod.value}{shown.contactMethod.note ? ` — ${shown.contactMethod.note}` : ''}
				</dd>
			</div>
			<div class="flex gap-1.5 sm:col-span-2">
				<dt class="text-muted-foreground">Ваша категория в предложении:</dt>
				<dd>
					{shown.category
						? `${shown.category.specialization} · ${gradeName(labels, shown.category.grade)}`
						: 'категория не подтверждена'}
				</dd>
			</div>
			{#if shown.vacancy}
				{@const vacancy = shown.vacancy.snapshot}
				<div class="flex gap-1.5 sm:col-span-2">
					<dt class="text-muted-foreground">Вакансия:</dt>
					<dd>
						«{vacancy.title}» · {vacancy.role_key ? roleName(labels, vacancy.role_key) : 'роль не указана'} · {range(
							vacancy.grade_min,
							vacancy.grade_max
						)}
					</dd>
				</div>
				<div class="flex gap-1.5 sm:col-span-2">
					<dt class="text-muted-foreground">Обязательные навыки:</dt>
					<dd>{vacancy.required_skill_keys.map((key) => skillName(labels, key)).join(', ') || 'не указаны'}</dd>
				</div>
			{/if}
		</dl>
		<div class="grid gap-1 rounded-lg border p-3 text-sm" data-testid="why-you">
			<h3 class="font-semibold">Почему вы — что компания увидела в твоём профиле</h3>
			<ul class="list-disc pl-5">
				{#each shown.whyYou as point, index (index)}
					<li>{point.text}</li>
				{/each}
			</ul>
		</div>
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
				Вы приняли версию {accepted.version}; она остаётся принятой, пока вы не ответите на новую.
			</p>
		{/if}
	</SectionCard>
{/if}

<SectionCard
	title="О компании"
	description={invitation.company.verification === 'verified'
		? 'Компания проверена оператором платформы.'
		: 'Компания не проверена оператором платформы: проверка необязательна, но учитывайте это при ответе.'}
	testId="offer-company"
>
	<p class="text-sm font-medium">
		{invitation.company.displayName}
		<span class={invitation.company.verification === 'verified' ? 'text-success' : 'text-warning'}>
			· {invitation.company.verification === 'verified' ? 'проверена' : 'не проверена'}
		</span>
	</p>
	{#if invitation.company.activity}
		<p class="text-sm text-muted-foreground">{invitation.company.activity}</p>
	{/if}
	{#if invitation.company.description}
		<p class="text-sm whitespace-pre-line">{invitation.company.description}</p>
	{/if}
	{#if Object.keys(invitation.company.contacts).length > 0}
		<dl class="grid gap-1 text-sm">
			{#if invitation.company.contacts.website}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">Сайт:</dt>
					<dd>{invitation.company.contacts.website}</dd>
				</div>
			{/if}
			{#if invitation.company.contacts.email}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">Почта:</dt>
					<dd>{invitation.company.contacts.email}</dd>
				</div>
			{/if}
			{#if invitation.company.contacts.phone}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">Телефон:</dt>
					<dd>{invitation.company.contacts.phone}</dd>
				</div>
			{/if}
			{#if invitation.company.contacts.telegram}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">Telegram:</dt>
					<dd>{invitation.company.contacts.telegram}</dd>
				</div>
			{/if}
		</dl>
	{/if}
	<div class="grid gap-2 border-t pt-3">
		<h3 class="text-sm font-semibold">Факты о компании</h3>
		<TrustFacts trust={invitation.companyTrust} />
	</div>
</SectionCard>

{#if awaiting}
	<SectionCard
		title="Ждём согласия законного представителя"
		description="До 18 лет контакты передаются компании, только когда согласие дал и законный представитель. Письмо со ссылкой ушло ему на почту."
		testId="awaiting-representative"
	>
		<p class="text-sm">
			Вы приняли приглашение {formatDateTime(awaiting.requestedAt)}. Представитель должен ответить до
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
			description="Принять — значит согласиться пообщаться с компанией, а не принять оффер: откроется переписка, компания получит выбранные контакты. Контакты получит только эта компания и только выбранные; раскрытие фиксируется в журнале, согласие можно отозвать."
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
						<option value="">{card.decline.reasonRequired ? '— выберите —' : '— не указывать —'}</option>
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
		description="Отзыв закрывает компании доступ к вашей карточке получателя сразу. Уже переданные контакты остаются у компании — так сказано в тексте согласия."
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
				Согласие на раскрытие отозвано: компания больше не видит ваши контакты.
			</p>
		{/if}
	</SectionCard>
{/if}

{#if invitation.status === 'accepted' || data.conversation.messages.length > 0}
	<SectionCard
		title="Переписка с компанией"
		description="Принятое приглашение — это согласие пообщаться с компанией, а не согласие на работу. Переписку видите вы и сотрудники этой компании; отзыв согласия на раскрытие контактов её закрывает."
		testId="conversation"
	>
		<OfferConversation conversation={data.conversation} otherName={invitation.company.displayName} reader="candidate" />
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
	<SectionCard title="История версий" description="Каждая версия условий хранится неизменной вместе с вашим ответом.">
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

<SectionCard
	title="Жалоба на предложение"
	description="Если компания ведёт себя недобросовестно, расскажите оператору ФСП. Компания не узнает, кто пожаловался, и не увидит текст; обоснованная жалоба попадает в факты о компании, которые видят другие кандидаты."
	testId="offer-complaint"
>
	{#if complaint}
		<div class="grid gap-1 text-sm">
			<p>
				<span class="text-muted-foreground">Причина:</span>
				{COMPLAINT_REASONS[complaint.reasonCode]} · подана {formatDateTime(complaint.createdAt)}
			</p>
			{#if complaint.status === 'open'}
				<p class="font-medium" data-complaint-status="open">На рассмотрении у оператора ФСП.</p>
			{:else if complaint.decision}
				<p class="font-medium" data-complaint-status="decided">
					Рассмотрена{complaint.decidedAt ? ` ${formatDateTime(complaint.decidedAt)}` : ''}: {COMPLAINT_DECISIONS[
						complaint.decision
					]}.
				</p>
				{#if complaint.resolution}
					<blockquote class="border-l-2 pl-3 whitespace-pre-line">{complaint.resolution}</blockquote>
				{/if}
			{/if}
		</div>
	{:else}
		<details class="rounded-lg border text-sm">
			<summary class="cursor-pointer px-3 py-2 font-medium">Пожаловаться</summary>
			<form method="POST" action="?/complain" use:enhance class="grid gap-4 px-3 pb-3">
				<CsrfInput />
				<label class="grid gap-1.5">
					<span>Что случилось</span>
					<select name="reason_code" class={selectClass} required>
						<option value="">— выберите —</option>
						{#each Object.entries(COMPLAINT_REASONS) as [code, label] (code)}
							<option value={code}>{label}</option>
						{/each}
					</select>
				</label>
				<label class="grid gap-1.5">
					<span>Подробности</span>
					<Textarea name="text" minlength={10} maxlength={2000} rows={4} required />
				</label>
				<Button type="submit" variant="outline" class="justify-self-start">Отправить жалобу</Button>
			</form>
		</details>
	{/if}
</SectionCard>
