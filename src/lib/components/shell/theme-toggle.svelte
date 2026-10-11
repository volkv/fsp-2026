<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button/index.js';

	type Mode = 'light' | 'dark' | 'system';

	// One click moves to the next mode in this order; the icon shows the chosen mode, not the resolved theme.
	const modes: Record<Mode, { label: string; icon: typeof SunIcon; next: Mode }> = {
		light: { label: 'светлая', icon: SunIcon, next: 'dark' },
		dark: { label: 'тёмная', icon: MoonIcon, next: 'system' },
		system: { label: 'как в системе', icon: MonitorIcon, next: 'light' }
	};

	const current = $derived(modes[userPrefersMode.current]);
</script>

<Button
	variant="ghost"
	size="icon"
	onclick={() => {
		setMode(current.next);
	}}
	aria-label="Тема оформления: {current.label}. Переключить на {modes[current.next].label}"
	title="Тема: {current.label}"
>
	<current.icon class="size-4" aria-hidden="true" />
</Button>
