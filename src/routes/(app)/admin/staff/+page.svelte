<script lang="ts">
	import { enhance } from '$app/forms';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { MEMBER_ROLES, STAFF_ROLES, USER_STATUSES } from '$lib/components/admin/model.js';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import DemoLockNotice from '$lib/components/product/demo-lock-notice.svelte';
	import { formatDate, formatDateTime } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const DONE: Record<string, string> = {
		granted: 'Роль выдана и записана в журнал. Она действует со следующего запроса пользователя.',
		revoked: 'Роль снята и записана в журнал. Кабинет закрывается со следующего запроса пользователя.',
		audit_granted: 'Оператору выдано право читать журнал действий.',
		audit_revoked: 'Право читать журнал действий снято.'
	};
	const done = $derived(form && 'done' in form && form.done ? DONE[form.done] : null);
	const found = $derived(data.found);
	const has = (grants: { role: string }[], role: string) => grants.some((grant) => grant.role === role);
</script>

<PageHeader
	title="Пользователи и персонал"
	description="Поиск аккаунта по точному адресу почты или идентификатору, роли персонала — оператор ФСП и администратор. Данные профиля кандидата здесь не показываются."
/>

{#if problem}
	<FormMessage text={problem.message} />
{:else if done}
	<FormMessage tone="success" text={done} />
{/if}

{#if data.demoLocked}
	<DemoLockNotice
		text="Роли персонала общие для всех посетителей стенда: в демо-сессии их можно посмотреть, но не выдать и не снять. Здесь видны только аккаунты вашей демо-сессии."
	/>
{/if}

<section aria-labelledby="search-heading" class="grid gap-4">
	<h2 id="search-heading" class="font-heading text-h3">Найти пользователя</h2>
	<form method="GET" class="flex flex-wrap items-end gap-3" role="search" data-tour="staff-search">
		<Field.Field class="w-96 max-w-full" data-invalid={data.searchProblem ? true : undefined}>
			<Field.Label for="user-q">Почта целиком или идентификатор аккаунта</Field.Label>
			<Input
				id="user-q"
				name="q"
				value={data.query}
				autocomplete="off"
				aria-invalid={data.searchProblem ? true : undefined}
				aria-describedby={data.searchProblem ? 'user-q-problem' : undefined}
			/>
			{#if data.searchProblem}
				<Field.Error id="user-q-problem">{data.searchProblem}</Field.Error>
			{/if}
		</Field.Field>
		<Button type="submit" variant="outline">Найти</Button>
	</form>
	<p class="text-sm text-muted-foreground">
		Адреса хранятся зашифрованными, поэтому поиск — только по точному совпадению, без перебора адресов.
	</p>

	{#if data.query !== '' && !data.searchProblem && found === null}
		<p class="text-sm" data-testid="user-not-found">Аккаунта с таким адресом или идентификатором нет.</p>
	{:else if found}
		{@const status = USER_STATUSES[found.status]}
		<Card.Root data-user={found.id}>
			<Card.Header>
				<Card.Title><h3 class="text-base font-medium">{found.displayName ?? 'Без имени'}</h3></Card.Title>
				<Card.Description class="font-mono text-xs">{found.id}</Card.Description>
				<Card.Action
					>{#if status}<StatusPill label={status.label} tone={status.tone} />{/if}</Card.Action
				>
			</Card.Header>
			<Card.Content class="grid gap-4 text-sm">
				<dl class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
					<div>
						<dt class="text-muted-foreground">Зарегистрирован</dt>
						<dd>{formatDate(found.createdAt)}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Последний вход</dt>
						<dd>{found.lastLoginAt ? formatDateTime(found.lastLoginAt) : 'не входил'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Кандидат</dt>
						<dd>{found.isCandidate ? 'есть профиль' : 'нет'}</dd>
					</div>
					<div>
						<dt class="text-muted-foreground">Работодатель</dt>
						<dd>
							{#if found.membership}
								{found.membership.companyName}, {MEMBER_ROLES[found.membership.role] ?? found.membership.role}
							{:else}
								нет
							{/if}
						</dd>
					</div>
				</dl>
				<div class="grid gap-2">
					<p class="text-muted-foreground">Роли персонала</p>
					{#if found.staff.length === 0}
						<p>нет</p>
					{:else}
						<ul class="flex flex-wrap gap-2">
							{#each found.staff as grant (grant.role)}
								<li>
									<StatusPill
										label="{STAFF_ROLES[grant.role]}{grant.extraPermissions.includes('audit.read') ? ' + журнал' : ''}"
										tone="info"
									/>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				{#if found.isSelf}
					<p class="text-muted-foreground">Это ваш аккаунт: свои роли меняет другой администратор.</p>
				{:else if data.demoLocked}
					<StatusPill label="В демо недоступно" />
				{:else if found.status !== 'active'}
					<p class="text-muted-foreground">Роли выдаются только активному аккаунту с подтверждённой почтой.</p>
				{:else}
					<div class="flex flex-wrap items-end gap-4">
						{#if !has(found.staff, 'operator')}
							<form
								method="POST"
								action="?/grant"
								use:enhance
								class="flex flex-wrap items-center gap-3 rounded-lg border p-3"
							>
								<CsrfInput />
								<input type="hidden" name="userId" value={found.id} />
								<input type="hidden" name="role" value="operator" />
								<label class="flex items-center gap-2">
									<input type="checkbox" name="auditRead" class="size-4" />
									с правом читать журнал
								</label>
								<Button type="submit" size="sm">Назначить оператором ФСП</Button>
							</form>
						{/if}
						{#if !has(found.staff, 'admin')}
							<form method="POST" action="?/grant" use:enhance class="rounded-lg border p-3">
								<CsrfInput />
								<input type="hidden" name="userId" value={found.id} />
								<input type="hidden" name="role" value="admin" />
								<Button type="submit" size="sm" variant="outline">Назначить администратором</Button>
							</form>
						{/if}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</section>

<section aria-labelledby="staff-heading" class="grid gap-4">
	<h2 id="staff-heading" class="font-heading text-h3">Персонал</h2>
	{#if data.staff.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><UsersIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Ролей персонала нет</Empty.Title>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<Card.Root>
			<Card.Content>
				<Table.Root label="Персонал" data-testid="staff">
					<Table.Header>
						<Table.Row>
							<Table.Head>Сотрудник</Table.Head>
							<Table.Head>Роль</Table.Head>
							<Table.Head>Выдана</Table.Head>
							<Table.Head><span class="sr-only">Действия</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.staff as member (member.userId)}
							{#each member.grants as grant (grant.role)}
								{@const auditRead = grant.extraPermissions.includes('audit.read')}
								<Table.Row data-staff={member.userId} data-role={grant.role}>
									<Table.Cell>
										<span class="font-medium">{member.displayName ?? 'Без имени'}</span>
										{#if member.isSelf}<span class="text-muted-foreground"> (вы)</span>{/if}
										<span class="block text-xs text-muted-foreground">{member.email}</span>
									</Table.Cell>
									<Table.Cell>
										{STAFF_ROLES[grant.role]}
										{#if grant.role === 'operator'}
											<span class="block text-xs text-muted-foreground">
												журнал действий: {auditRead ? 'читает' : 'нет права'}
											</span>
										{/if}
									</Table.Cell>
									<Table.Cell class="whitespace-nowrap">{formatDate(grant.grantedAt)}</Table.Cell>
									<Table.Cell>
										{#if data.demoLocked}
											<StatusPill label="В демо недоступно" />
										{:else if !member.isSelf}
											<div class="flex flex-wrap justify-end gap-2">
												{#if grant.role === 'operator'}
													<form method="POST" action="?/auditRead" use:enhance>
														<CsrfInput />
														<input type="hidden" name="userId" value={member.userId} />
														<input type="hidden" name="enabled" value={auditRead ? 'false' : 'true'} />
														<Button type="submit" size="sm" variant="outline">
															{auditRead ? 'Снять право на журнал' : 'Дать право на журнал'}
														</Button>
													</form>
												{/if}
												<form method="POST" action="?/revoke" use:enhance>
													<CsrfInput />
													<input type="hidden" name="userId" value={member.userId} />
													<input type="hidden" name="role" value={grant.role} />
													<Button type="submit" size="sm" variant="destructive">Снять роль</Button>
												</form>
											</div>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{/if}
</section>
