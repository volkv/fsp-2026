<script lang="ts">
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import FilePlusIcon from '@lucide/svelte/icons/file-plus';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import type { ComponentProps } from 'svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import VacancySource, { type VacancySourceView } from '$lib/components/candidate/vacancy-source.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { SalaryRange } from '$lib/components/product/index.js';
	import { formatDate, type SalaryView } from '$lib/components/product/model.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { cn } from '$lib/components/utils.js';
	import { CLAIM_STATUSES } from './model.js';
	import PoolCounter from './pool-counter.svelte';

	/**
	 * An external vacancy as an employer sees it (domain 13.2–13.3): the source with its attribution and the link to the
	 * original, what the postings say about the role and the range, «in the pool: N confirmed candidates» and the
	 * «this is our vacancy» claim of the company, which it can take back while the claim is open. A claim gives no right
	 * to invite: after the operator confirms it, the company creates its own vacancy on the basis of this one
	 * (`/company/vacancies/new?from=`) and publishes it.
	 */
	type ClaimStatus = 'awaiting_company_verification' | 'pending_review' | 'approved' | 'rejected' | 'withdrawn';

	interface Vacancy {
		id: string;
		title: string;
		organization: string | null;
		roleKey: string | null;
		gradeMin: string | null;
		gradeMax: string | null;
		workFormat: string | null;
		requiredSkillKeys: string[];
		salary: {
			min: number | null;
			max: number | null;
			currency: string | null;
			period: 'month' | 'year' | 'hour' | 'project' | null;
			taxBase: 'gross' | 'net' | 'unknown' | null;
		};
		postings: VacancySourceView[];
		pool: ComponentProps<typeof PoolCounter>['pool'];
		claim: { id: string; status: ClaimStatus; reason: string | null; requestedAt: Date } | null;
		claimedBy: 'none' | 'this_company' | 'other_company';
	}

	interface Labels {
		roles: Record<string, string>;
		grades: Record<string, string>;
		skills: Record<string, string>;
		workFormats: Record<string, string>;
	}

	interface Props {
		vacancy: Vacancy;
		labels: Labels;
		/**
		 * Whether the company may file a claim now: `open` — verified, the claim goes to an FSP operator;
		 * `after_verification` — not verified yet, the claim waits for the verification of the company; `closed` —
		 * rejected or suspended.
		 */
		access: 'open' | 'after_verification' | 'closed';
		/** The answer of the last claim action, when it was about this vacancy. */
		result: { kind: 'claimed'; status: ClaimStatus } | { kind: 'problem'; message: string } | null;
	}

	let { vacancy, labels, access, result }: Props = $props();

	const OPEN: readonly ClaimStatus[] = ['awaiting_company_verification', 'pending_review'];
	const claimOpen = $derived(vacancy.claim !== null && OPEN.includes(vacancy.claim.status));

	const salary = $derived<SalaryView>({
		min: vacancy.salary.min,
		max: vacancy.salary.max,
		...(vacancy.salary.currency === null ? {} : { currency: vacancy.salary.currency }),
		...(vacancy.salary.period === null ? {} : { period: vacancy.salary.period }),
		...(vacancy.salary.taxBase === null ? {} : { taxBase: vacancy.salary.taxBase })
	});

	const grade = $derived.by(() => {
		const { gradeMin: min, gradeMax: max } = vacancy;
		if (min === null || max === null) return null;
		const name = (key: string) => labels.grades[key] ?? key;
		return min === max ? name(min) : `${name(min)}–${name(max)}`;
	});

	const terms = $derived(
		[
			vacancy.roleKey === null ? 'роль не указана' : (labels.roles[vacancy.roleKey] ?? vacancy.roleKey),
			grade ?? 'грейд не указан',
			vacancy.workFormat === null ? null : (labels.workFormats[vacancy.workFormat] ?? vacancy.workFormat)
		].filter((part): part is string => part !== null)
	);

	const claimedText: Record<ClaimStatus, string> = {
		awaiting_company_verification: 'Заявка подана и ждёт проверки компании: после неё заявку рассмотрит оператор ФСП.',
		pending_review: 'Заявка подана: оператор ФСП сверит организацию из публикации с реквизитами компании.',
		approved: 'Заявка подтверждена.',
		rejected: 'Заявка отклонена.',
		withdrawn: 'Заявка отозвана.'
	};
</script>

<Card.Root data-external-vacancy={vacancy.id}>
	<Card.Header>
		<Card.Title>
			<h2 class="font-heading text-h3">{vacancy.title}</h2>
		</Card.Title>
		<Card.Description>
			{vacancy.organization ?? 'Организация в публикации не названа'} · {terms.join(' · ')}
		</Card.Description>
	</Card.Header>
	<Card.Content class="grid gap-4">
		<VacancySource postings={vacancy.postings} />
		<SalaryRange {salary} />
		{#if vacancy.requiredSkillKeys.length > 0}
			<p class="text-sm">
				<span class="text-muted-foreground">Обязательные навыки:</span>
				{vacancy.requiredSkillKeys.map((key) => labels.skills[key] ?? key).join(', ')}
			</p>
		{/if}
		<PoolCounter pool={vacancy.pool} />

		<div
			class="grid gap-2 border-t pt-4 text-sm"
			data-testid="claim"
			data-claim-status={vacancy.claim?.status ?? 'none'}
		>
			{#if result?.kind === 'problem'}
				<FormMessage text={result.message} />
			{:else if result?.kind === 'claimed'}
				<FormMessage tone="success" text={claimedText[result.status]} />
			{/if}

			{#if vacancy.claimedBy === 'this_company'}
				<p class="flex flex-wrap items-center gap-2">
					<StatusPill label="Подтверждена за вашей компанией" tone="success" />
				</p>
				<p class="text-muted-foreground">
					Опубликуйте её как свою вакансию с полной вилкой: приглашать кандидатов можно только по своей вакансии.
				</p>
				<a
					class={cn(buttonVariants({ variant: 'outline' }), 'justify-self-start')}
					href="{resolve('/company/vacancies/new')}?from={encodeURIComponent(vacancy.id)}"
				>
					<FilePlusIcon aria-hidden="true" />
					Создать на основе
				</a>
			{:else if vacancy.claimedBy === 'other_company'}
				<p class="text-muted-foreground">Эту вакансию уже подтвердила за собой другая компания.</p>
			{:else if claimOpen && vacancy.claim}
				<p class="flex flex-wrap items-center gap-2">
					<StatusPill label={CLAIM_STATUSES[vacancy.claim.status] ?? vacancy.claim.status} tone="info" />
					<span class="text-muted-foreground">заявка подана {formatDate(vacancy.claim.requestedAt)}</span>
				</p>
				<form method="POST" action="?/withdrawClaim" use:enhance class="flex flex-wrap items-center gap-3">
					<CsrfInput />
					<input type="hidden" name="vacancy_id" value={vacancy.id} />
					<input type="hidden" name="claim_id" value={vacancy.claim.id} />
					<Button type="submit" variant="outline">
						<UndoIcon aria-hidden="true" />
						Отозвать заявку
					</Button>
					<span class="text-xs text-muted-foreground"
						>Оператор её больше не увидит; новую заявку можно подать позже</span
					>
				</form>
			{:else}
				{#if vacancy.claim?.status === 'rejected'}
					<p class="flex flex-wrap items-center gap-2">
						<StatusPill label={CLAIM_STATUSES.rejected ?? 'Отклонена'} tone="danger" />
						<span class="text-muted-foreground">прошлая заявка от {formatDate(vacancy.claim.requestedAt)}</span>
					</p>
					{#if vacancy.claim.reason}
						<p class="text-muted-foreground">Причина отказа: {vacancy.claim.reason}</p>
					{/if}
				{/if}
				{#if access === 'closed'}
					<p class="text-muted-foreground">Заявки недоступны: компания отклонена или приостановлена оператором ФСП.</p>
				{:else}
					<form method="POST" action="?/claim" use:enhance class="flex flex-wrap items-center gap-3">
						<CsrfInput />
						<input type="hidden" name="vacancy_id" value={vacancy.id} />
						<Button type="submit" variant="outline">
							<BadgeCheckIcon aria-hidden="true" />
							Это наша вакансия
						</Button>
						<span class="text-xs text-muted-foreground">
							{access === 'open'
								? 'Заявку рассмотрит оператор ФСП'
								: 'Заявка подождёт проверки компании, затем её рассмотрит оператор ФСП'}
						</span>
					</form>
				{/if}
			{/if}
		</div>
	</Card.Content>
</Card.Root>
