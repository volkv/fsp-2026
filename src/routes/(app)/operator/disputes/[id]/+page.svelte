<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { ATTESTATIONS, STRENGTH_BANDS } from '$lib/components/candidate/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormProblem from '$lib/components/forms/form-message.svelte';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DueStatus from '$lib/components/operator/due-status.svelte';
	import { DISPUTE_STATUSES } from '$lib/components/operator/model.js';
	import RunCategory from '$lib/components/operator/run-category.svelte';
	import { TrustChip } from '$lib/components/product/index.js';
	import { formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const d = $derived(data.dispute);
	const status = $derived(DISPUTE_STATUSES[d.status]);
	const labels = $derived({
		roles: data.labels.roles,
		grades: data.labels.grades,
		skills: data.labels.skills,
		workFormats: data.labels.terms.work_format,
		employmentForms: data.labels.terms.employment_form
	});
	const active = $derived(d.status === 'open' || d.status === 'in_review');
	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const fieldError = (name: string) => problem?.fields[name];
	const primary = $derived(d.disputed.assignments.find((a) => a.rank === 'primary') ?? null);
	const ANSWERED: Record<string, string> = {
		upheld: 'Ответ отправлен: категория оставлена.',
		changed: 'Категория заменена ручным решением. Оно действует, пока профиль кандидата не изменится.'
	};
	let answer = $state<'uphold' | 'change'>('uphold');
</script>

<PageHeader title="Возражение по категории" description={`Подано ${formatDateTime(d.openedAt)}.`}>
	{#snippet eyebrow()}
		<a class="underline-offset-4 hover:underline" href={resolve('/operator/disputes')}>Возражения</a>
	{/snippet}
	{#snippet actions()}
		{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}
	{/snippet}
</PageHeader>

{#if problem}
	<FormProblem text={problem.message} />
{:else if data.answered && ANSWERED[data.answered]}
	<FormProblem tone="success" text={ANSWERED[data.answered] ?? ''} />
{:else if form && 'taken' in form}
	<FormProblem tone="success" text="Возражение у вас в работе: ответ даёте вы." />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" data-dispute={d.id} data-status={d.status}>
	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Что пишет кандидат</h2></Card.Title>
			</Card.Header>
			<Card.Content>
				<blockquote class="border-l-2 pl-4 whitespace-pre-line" data-testid="dispute-reason">{d.reason}</blockquote>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Оспариваемая категория</h2></Card.Title>
				{#if d.stale && active}
					<Card.Description class="text-warning">
						Категорию уже пересчитали после возражения: оспариваемая больше не действует. Ручная замена недоступна —
						можно оставить категорию с пояснением.
					</Card.Description>
				{/if}
			</Card.Header>
			<Card.Content>
				<RunCategory run={d.disputed} {labels} grades={data.grades} fspLevels={d.candidate?.fspLevels ?? []} />
			</Card.Content>
		</Card.Root>

		{#if d.candidate}
			{@const candidate = d.candidate}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Основания в профиле</h2></Card.Title>
					<Card.Description>
						Данные кандидата открыты только на время дела; каждое открытие записано в журнал.
						{candidate.isMinor ? 'Кандидату 14–17 лет.' : ''}
					</Card.Description>
				</Card.Header>
				<Card.Content class="grid gap-4 text-sm">
					{#if candidate.desiredRoleKeys.length > 0}
						<p>
							<span class="text-muted-foreground">Желаемые роли:</span>
							{candidate.desiredRoleKeys.map((key) => labels.roles[key] ?? key).join(', ')}
						</p>
					{/if}
					{#if candidate.skills.length === 0}
						<p class="text-muted-foreground">Выведенных навыков нет.</p>
					{:else}
						<ul class="grid gap-2" aria-label="Навыки расчёта">
							{#each candidate.skills as skill (skill.skillKey)}
								<li class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{labels.skills[skill.skillKey] ?? skill.skillKey}</span>
									{#if skill.badgeTrust}
										<TrustChip level={skill.badgeTrust} />
									{:else}
										<TrustChip level={skill.attestation === 'derived' ? 'derived' : 'claimed'} />
									{/if}
									<span class="text-muted-foreground">
										{STRENGTH_BANDS[skill.band]}, {ATTESTATIONS[skill.attestation]}
									</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if candidate.resume}
						<a
							class="inline-flex items-center gap-2 text-link underline-offset-4 hover:underline"
							href="{resolve('/(app)/operator/disputes/[id]/resume', { id: d.id })}?file={candidate.resume.fileId}"
						>
							<DownloadIcon class="size-4" aria-hidden="true" />
							Резюме по делу: {candidate.resume.declaredName}
						</a>
					{:else}
						<p class="text-muted-foreground">Резюме не загружено.</p>
					{/if}
				</Card.Content>
			</Card.Root>
		{/if}

		{#if d.resulting}
			<Card.Root>
				<Card.Header>
					<Card.Title><h2 class="font-heading text-h3">Категория после решения</h2></Card.Title>
				</Card.Header>
				<Card.Content>
					<RunCategory run={d.resulting} {labels} grades={data.grades} />
				</Card.Content>
			</Card.Root>
		{/if}
	</div>

	<div class="grid content-start gap-6">
		<Card.Root>
			<Card.Header>
				<Card.Title><h2 class="font-heading text-h3">Ответ</h2></Card.Title>
				<Card.Description>
					{#if d.assignee}
						Ответственный: {d.mine ? 'вы' : (d.assignee.name ?? 'оператор')}.
					{:else}
						Ответственный не назначен.
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				{#if active}
					<DueStatus dueAt={d.dueAt} now={data.now} overdue={d.overdue} dueSoon={d.dueSoon} />
					{#if !d.mine}
						<form method="POST" action="?/take" use:enhance>
							<CsrfInput />
							<Button type="submit">{d.assignee ? 'Взять себе' : 'Взять в работу'}</Button>
						</form>
					{:else}
						<fieldset class="grid gap-2">
							<legend class="mb-1 font-medium">Решение</legend>
							<label class="flex items-center gap-2">
								<input type="radio" name="answer-kind" value="uphold" bind:group={answer} class="size-4" />
								Оставить категорию
							</label>
							<label class="flex items-center gap-2">
								<input
									type="radio"
									name="answer-kind"
									value="change"
									bind:group={answer}
									disabled={d.stale}
									class="size-4"
								/>
								Заменить ручным решением
							</label>
						</fieldset>
						<form
							method="POST"
							action={answer === 'uphold' ? '?/uphold' : '?/change'}
							use:enhance
							class="grid gap-4"
							data-testid="answer-form"
						>
							<CsrfInput />
							{#if answer === 'change'}
								<Field.Field data-invalid={fieldError('axes.roleKey') !== undefined}>
									<Field.Label for="override-role">Роль</Field.Label>
									<NativeSelect id="override-role" name="roleKey" value={primary?.role.key ?? ''}>
										<option value="">Недостаточно данных</option>
										{#each data.roles as role (role.key)}
											<option value={role.key}>{role.name}</option>
										{/each}
									</NativeSelect>
									{#if fieldError('axes.roleKey')}<Field.Error>{fieldError('axes.roleKey')}</Field.Error>{/if}
								</Field.Field>
								<div class="grid gap-3 sm:grid-cols-3">
									<Field.Field data-invalid={fieldError('axes.grade') !== undefined}>
										<Field.Label for="override-grade-min">Грейд от</Field.Label>
										<NativeSelect id="override-grade-min" name="gradeMin" value={primary?.grade.min ?? ''}>
											<option value="">—</option>
											{#each data.grades as grade (grade.key)}
												<option value={grade.key}>{grade.name}</option>
											{/each}
										</NativeSelect>
									</Field.Field>
									<Field.Field>
										<Field.Label for="override-grade-max">до</Field.Label>
										<NativeSelect id="override-grade-max" name="gradeMax" value={primary?.grade.max ?? ''}>
											<option value="">—</option>
											{#each data.grades as grade (grade.key)}
												<option value={grade.key}>{grade.name}</option>
											{/each}
										</NativeSelect>
									</Field.Field>
									<Field.Field data-invalid={fieldError('axes.grade.confidence') !== undefined}>
										<Field.Label for="override-confidence">Уверенность</Field.Label>
										<Input
											id="override-confidence"
											name="gradeConfidence"
											inputmode="decimal"
											placeholder="0,7"
											value={primary?.grade.confidence?.toString() ?? ''}
										/>
									</Field.Field>
								</div>
								{#if fieldError('axes.grade') || fieldError('axes.grade.confidence')}
									<p class="text-destructive">{fieldError('axes.grade') ?? fieldError('axes.grade.confidence')}</p>
								{/if}
								<fieldset class="grid gap-1.5" data-invalid={fieldError('axes.stackSkillKeys') !== undefined}>
									<legend class="mb-1 font-medium">Ядро стека (до трёх навыков)</legend>
									{#each [0, 1, 2] as slot (slot)}
										<NativeSelect
											name="stackSkillKeys"
											aria-label={`Навык ${slot + 1}`}
											value={primary?.stack.skillKeys[slot] ?? ''}
										>
											<option value="">—</option>
											{#each data.skills as skill (skill.key)}
												<option value={skill.key}>{skill.name}</option>
											{/each}
										</NativeSelect>
									{/each}
									{#if fieldError('axes.stackSkillKeys')}
										<p class="text-destructive">{fieldError('axes.stackSkillKeys')}</p>
									{/if}
								</fieldset>
								{#if fieldError('axes')}<p class="text-destructive">{fieldError('axes')}</p>{/if}
							{/if}
							<Field.Field data-invalid={fieldError('resolution') !== undefined}>
								<Field.Label for="resolution">Ответ кандидату</Field.Label>
								<Textarea id="resolution" name="resolution" rows={5} required maxlength={4000} />
								<Field.Description>
									{answer === 'uphold'
										? 'Почему категория верна и что поможет её изменить.'
										: 'Обоснование ручного решения: какие основания вы сверили.'}
								</Field.Description>
								{#if fieldError('resolution')}<Field.Error>{fieldError('resolution')}</Field.Error>{/if}
							</Field.Field>
							<Button type="submit" class="justify-self-start">
								{answer === 'uphold' ? 'Оставить категорию' : 'Заменить категорию'}
							</Button>
						</form>
					{/if}
				{:else}
					{#if d.resolution}
						<p class="whitespace-pre-line" data-testid="resolution">{d.resolution}</p>
					{/if}
					{#if d.resolvedAt}<p class="text-muted-foreground">Решено {formatDateTime(d.resolvedAt)}.</p>{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
