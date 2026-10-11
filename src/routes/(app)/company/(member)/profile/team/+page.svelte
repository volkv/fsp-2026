<script lang="ts">
	import { enhance } from '$app/forms';
	import CompanyTabs from '$lib/components/employer/company-tabs.svelte';
	import { MEMBER_ROLES } from '$lib/components/employer/model.js';
	import NativeSelect from '$lib/components/employer/native-select.svelte';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import StatusPill from '$lib/components/forms/status-pill.svelte';
	import { formatDate } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const problem = $derived(form && 'problem' in form ? form.problem : null);
	const active = $derived(data.members.filter((member) => member.status === 'active'));
	const invited = $derived(data.members.filter((member) => member.status === 'invited'));
</script>

<PageHeader
	title="Команда"
	description="Владельцы управляют компанией, командой и ключами; рекрутеры ведут вакансии, подбор и приглашения."
/>

<CompanyTabs role={data.role} />

{#if problem}
	<FormMessage text={problem.message} />
{:else if form && 'invited' in form && form.invited}
	<FormMessage
		tone={form.invited.letterSent ? 'success' : 'error'}
		text={form.invited.letterSent
			? 'Приглашение отправлено: ссылка действует ограниченное время.'
			: 'Приглашение сохранено, но письмо не ушло — почтовый сервер недоступен. Пригласите тот же адрес ещё раз.'}
	/>
{:else if form && ('changed' in form || 'removed' in form)}
	<FormMessage tone="success" text="Команда обновлена." />
{/if}

<div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<Card.Root>
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Участники</h2></Card.Title>
		</Card.Header>
		<Card.Content>
			<Table.Root label="Участники команды">
				<Table.Header>
					<Table.Row>
						<Table.Head>Участник</Table.Head>
						<Table.Head>Роль</Table.Head>
						<Table.Head class="text-right">Действия</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each active as member (member.memberId)}
						{@const self = member.memberId === data.selfMemberId}
						<Table.Row data-member={member.memberId}>
							<Table.Cell>
								<span class="font-medium">{member.displayName ?? 'Без имени'}</span>
								{#if self}<span class="text-muted-foreground"> · это вы</span>{/if}
								{#if member.joinedAt}
									<span class="block text-xs text-muted-foreground">в команде с {formatDate(member.joinedAt)}</span>
								{/if}
							</Table.Cell>
							<Table.Cell>{MEMBER_ROLES[member.role]}</Table.Cell>
							<Table.Cell>
								{#if !self}
									<div class="flex flex-wrap justify-end gap-2">
										<form method="POST" action="?/role" use:enhance>
											<CsrfInput />
											<input type="hidden" name="memberId" value={member.memberId} />
											<input type="hidden" name="role" value={member.role === 'owner' ? 'recruiter' : 'owner'} />
											<Button type="submit" size="sm" variant="outline">
												{member.role === 'owner' ? 'Сделать рекрутером' : 'Сделать владельцем'}
											</Button>
										</form>
										{#if member.role === 'recruiter'}
											<form method="POST" action="?/transfer" use:enhance>
												<CsrfInput />
												<input type="hidden" name="memberId" value={member.memberId} />
												<Button type="submit" size="sm" variant="outline">Передать владение</Button>
											</form>
										{/if}
										<form method="POST" action="?/remove" use:enhance>
											<CsrfInput />
											<input type="hidden" name="memberId" value={member.memberId} />
											<Button type="submit" size="sm" variant="ghost" class="text-destructive">Исключить</Button>
										</form>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#if invited.length > 0}
				<h3 class="mt-6 mb-2 text-sm font-semibold">Приглашены, ещё не вступили</h3>
				<ul class="grid gap-2">
					{#each invited as member (member.memberId)}
						<li class="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
							<span>
								<StatusPill label={MEMBER_ROLES[member.role]} />
								<span class="text-muted-foreground"
									>приглашение от {formatDate(member.invitedAt)}; адрес хранится только в виде хэша</span
								>
							</span>
							<form method="POST" action="?/remove" use:enhance>
								<CsrfInput />
								<input type="hidden" name="memberId" value={member.memberId} />
								<Button type="submit" size="sm" variant="ghost">Отозвать</Button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root data-tour="team-invite">
		<Card.Header>
			<Card.Title><h2 class="font-heading text-h3">Пригласить в команду</h2></Card.Title>
			<Card.Description>Человек вступит по ссылке из письма под тем же адресом.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/invite" use:enhance class="grid gap-4">
				<CsrfInput />
				<Field.Field data-invalid={problem?.fields.email !== undefined}>
					<Field.Label for="invite-email">Рабочая почта</Field.Label>
					<Input id="invite-email" name="email" type="email" autocomplete="off" required />
					{#if problem?.fields.email}<Field.Error>{problem.fields.email}</Field.Error>{/if}
				</Field.Field>
				<Field.Field>
					<Field.Label for="invite-role">Роль</Field.Label>
					<NativeSelect id="invite-role" name="role" value="recruiter">
						<option value="recruiter">{MEMBER_ROLES.recruiter}</option>
						<option value="owner">{MEMBER_ROLES.owner}</option>
					</NativeSelect>
				</Field.Field>
				<Button type="submit" class="justify-self-start">Пригласить</Button>
			</form>
		</Card.Content>
	</Card.Root>
</div>
