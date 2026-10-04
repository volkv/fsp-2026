<script lang="ts">
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { toggleMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button/index.js';
</script>

<Button variant="ghost" size="icon" onclick={toggleMode} aria-label="Переключить светлую и тёмную тему">
	<SunIcon class="size-4 dark:hidden" aria-hidden="true" />
	<MoonIcon class="hidden size-4 dark:block" aria-hidden="true" />
</Button>
