<script lang="ts">
	import AuthPage from '../../auth-page.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<AuthPage title={data.document.title} description="Редакция {data.document.version}" width="wide">
	<!-- The text is shown as published: paragraphs and line breaks of the source are kept. -->
	<article class="max-w-none text-sm leading-relaxed whitespace-pre-line" data-testid="document-body">
		{data.document.body}
	</article>
</AuthPage>
