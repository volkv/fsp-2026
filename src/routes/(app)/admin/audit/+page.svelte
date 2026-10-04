<script lang="ts">
	import { resolve } from '$app/paths';
	import Journal from '$lib/components/admin/journal.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Журнал действий"
	description="События с актором, объектом и кодами — без адресов, контактов и текстов. Каждое чтение журнала само записывается в журнал."
/>

<Journal view={data} base={resolve('/admin/audit')} />
