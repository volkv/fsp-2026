<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { DISCLOSURE_FIELDS } from '$lib/components/candidate/model.js';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import AuthPage from '../../auth-page.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<AuthPage
	title="Раскрытие контактов компании"
	description="До 18 лет контакты кандидата передаются компании только с согласия законного представителя. Ответ фиксируется с редакцией текста согласия, временем и адресом, с которого вы открыли ссылку."
	width="wide"
>
	{#if form?.answered === 'grant'}
		<FormMessage
			tone="success"
			text="Согласие дано: приглашение принято, компания получила выбранные контакты. Кандидат и компания уведомлены."
		/>
	{:else if form?.answered === 'decline'}
		<FormMessage
			tone="success"
			text="Ответ записан: вы не дали согласия, приглашение отклонено и контакты не переданы. Кандидат и компания уведомлены."
		/>
	{:else if data.request}
		{#if form?.message}
			<FormMessage tone="error" text={form.message} />
		{/if}
		{@const request = data.request}
		<section class="grid gap-3" aria-labelledby="invitation-title" data-testid="representative-disclosure">
			<h2 id="invitation-title" class="font-heading text-h3">
				{request.offerTitle} <span class="text-muted-foreground">· {request.companyName}</span>
			</h2>
			<p>
				Кандидат <strong>{request.candidateName}</strong> принимает приглашение компании «{request.companyName}».
			</p>
			<SalaryRange salary={request.salary} size="lg" />
			{#if request.message}
				<blockquote class="border-l-2 pl-3 text-sm whitespace-pre-line">{request.message}</blockquote>
			{/if}
			<p class="text-sm">
				Компания получит: <strong>{request.fields.map((field) => DISCLOSURE_FIELDS[field]).join(', ')}</strong>.
			</p>
			<p class="text-sm text-muted-foreground">
				Ответить нужно до {formatDateTime(request.dueAt)} — это срок ответа на приглашение. После раскрытия компания самостоятельно
				отвечает за полученные контакты; отозвать согласие можно, но переданное останется у компании.
			</p>
		</section>
		<details class="rounded-lg border text-sm">
			<summary class="cursor-pointer px-3 py-2 font-medium">
				{request.document.title} · редакция {request.document.version}
			</summary>
			<!-- A scrollable region takes focus so it can be scrolled from the keyboard. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div
				class="max-h-64 overflow-y-auto px-3 pb-3 whitespace-pre-line outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				data-testid="disclosure-consent-text"
				role="region"
				aria-label="Текст согласия на раскрытие"
				tabindex="0"
			>
				{request.document.body}
			</div>
		</details>
		<div class="flex flex-wrap gap-3">
			<form method="POST" action="?/grant">
				<CsrfField viewer={data.viewer} />
				<input type="hidden" name="token" value={data.token} />
				<input type="hidden" name="documentId" value={request.document.id} />
				<Button type="submit" size="lg">
					<CheckIcon aria-hidden="true" />
					Согласен на раскрытие
				</Button>
			</form>
			<form method="POST" action="?/decline">
				<CsrfField viewer={data.viewer} />
				<input type="hidden" name="token" value={data.token} />
				<Button type="submit" size="lg" variant="outline">
					<XIcon aria-hidden="true" />
					Не согласен
				</Button>
			</form>
		</div>
	{:else}
		<FormMessage
			tone="error"
			text="Ссылка недействительна или ответ больше не нужен: ссылка устарела или использована, приглашение изменилось или закрылось, истёк срок ответа либо кандидат отменил принятие."
		/>
	{/if}
</AuthPage>
