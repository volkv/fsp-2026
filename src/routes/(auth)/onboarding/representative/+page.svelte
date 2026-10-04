<script lang="ts">
	import { enhance } from '$app/forms';
	import CsrfField from '$lib/components/forms/csrf-input.svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import AuthPage from '../../auth-page.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const errors: Partial<Record<string, string>> = $derived(form?.errors ?? {});
	const relations = [
		{ value: 'parent', label: 'Родитель' },
		{ value: 'adoptive_parent', label: 'Усыновитель' },
		{ value: 'guardian', label: 'Опекун' },
		{ value: 'custodian', label: 'Попечитель' }
	];
</script>

<AuthPage
	title="Законный представитель"
	description="До 18 лет профиль открывается с согласия законного представителя. Мы напишем ему; полномочия проверит оператор ФСП по документу."
>
	<form method="POST" use:enhance class="grid gap-5">
		<CsrfField viewer={data.viewer} />
		<Field.Group>
			<Field.Field data-invalid={errors.fullName ? true : undefined}>
				<Field.Label for="rep-name">Фамилия, имя и отчество</Field.Label>
				<Input
					id="rep-name"
					name="fullName"
					required
					value={form?.values.fullName ?? ''}
					aria-invalid={errors.fullName ? true : undefined}
					aria-describedby={errors.fullName ? 'rep-name-error' : undefined}
				/>
				{#if errors.fullName}<Field.Error id="rep-name-error">{errors.fullName}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.email ? true : undefined}>
				<Field.Label for="rep-email">Почта представителя</Field.Label>
				<Input
					id="rep-email"
					name="email"
					type="email"
					required
					value={form?.values.email ?? ''}
					aria-invalid={errors.email ? true : undefined}
					aria-describedby={errors.email ? 'rep-email-error' : undefined}
				/>
				{#if errors.email}<Field.Error id="rep-email-error">{errors.email}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.relation ? true : undefined}>
				<Field.Label for="rep-relation">Кем приходится</Field.Label>
				<select
					id="rep-relation"
					name="relation"
					required
					class="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
					aria-invalid={errors.relation ? true : undefined}
				>
					{#each relations as relation (relation.value)}
						<option value={relation.value} selected={form?.values.relation === relation.value}>{relation.label}</option>
					{/each}
				</select>
				{#if errors.relation}<Field.Error>{errors.relation}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
		<Button type="submit" size="lg">Отправить приглашение</Button>
	</form>
</AuthPage>
