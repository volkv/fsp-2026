<script lang="ts">
	import { AppHeader } from '$lib/components/shell/index.js';
	import { WORKSPACES, type Workspace } from '$lib/navigation.js';
	import ShowcaseSection from './showcase-section.svelte';
	import Specimen from './specimen.svelte';

	const workspaces = Object.keys(WORKSPACES) as Workspace[];
</script>

<ShowcaseSection
	id="shell"
	title="Оболочка"
	description="Шапка «ФСП | Карьера» и разделы по ролям (src/lib/navigation.ts). Каждый раздел ведёт на свою страницу, самые нужные — первыми; на узком экране меню открывается кнопкой."
>
	<div class="grid gap-4">
		{#each workspaces as workspace (workspace)}
			<Specimen title="Шапка: {WORKSPACES[workspace].label}" class="p-0 pt-4 [&>figcaption]:px-4">
				<AppHeader {workspace} pathname="/design" class="static rounded-b-xl" />
			</Specimen>
		{/each}
	</div>
</ShowcaseSection>
