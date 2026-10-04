<script lang="ts">
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { formatDate } from '$lib/components/product/model.js';

	/** A posting of an external vacancy as its card names it: the terms of the source require the attribution. */
	export interface VacancySourceView {
		sourceName: string;
		attribution: string;
		url: string;
		freshness: 'active' | 'gone' | 'unknown';
		lastCheckedAt: Date;
	}

	interface Props {
		postings: readonly VacancySourceView[];
	}

	let { postings }: Props = $props();
</script>

<ul class="grid gap-1 text-sm" data-testid="vacancy-sources">
	{#each postings as posting (posting.url)}
		<li class="flex flex-wrap items-center gap-x-2 gap-y-1" data-freshness={posting.freshness}>
			<span>{posting.attribution}</span>
			<a
				class="inline-flex items-center gap-1 text-link underline underline-offset-4"
				href={posting.url}
				rel="external noopener nofollow"
				target="_blank"
			>
				Оригинал вакансии
				<ExternalLinkIcon class="size-3.5" aria-hidden="true" />
				<span class="sr-only">на сайте «{posting.sourceName}» (откроется в новой вкладке)</span>
			</a>
			<span class="text-muted-foreground">
				{posting.freshness === 'gone' ? 'снята в источнике' : 'актуальность проверена'}
				{formatDate(posting.lastCheckedAt)}
			</span>
		</li>
	{/each}
</ul>
