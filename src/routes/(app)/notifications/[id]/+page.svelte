<script lang="ts">
	import { resolve } from '$app/paths';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<div class="mx-auto grid w-full max-w-3xl gap-6 px-4 py-8 sm:px-6 sm:py-10">
	<PageHeader
		title={data.title}
		description="То, о чём это уведомление, больше недоступно: приглашение отозвано или удалено, вы больше не в команде компании либо доступа к нему больше нет."
	/>
	<a
		href={resolve('/notifications')}
		class="{buttonVariants({ variant: 'outline' })} justify-self-start"
		data-tour="notification-back"
	>
		Ко всем уведомлениям
	</a>
</div>
