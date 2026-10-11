<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { Button } from '$lib/components/ui/button/index.js';

	type Mode = 'light' | 'dark' | 'system';

	// One click moves to the next mode in this order; the icon shows the chosen mode, not the resolved theme.
	const modes: Record<Mode, { label: string; next: Mode }> = {
		light: { label: 'светлая', next: 'dark' },
		dark: { label: 'тёмная', next: 'system' },
		system: { label: 'как в системе', next: 'light' }
	};

	// The server cannot know the saved mode, so the markup never depends on it: all three icons are rendered and CSS
	// shows the one named by `data-theme-mode` on <html> (set before the first paint by static/theme-init.js, kept in
	// sync here), and the label names the mode only once the component runs in the browser.
	let mounted = $state(false);
	const current = $derived(userPrefersMode.current);

	$effect(() => {
		mounted = true;
		document.documentElement.dataset.themeMode = current;
	});
</script>

<Button
	variant="ghost"
	size="icon"
	onclick={() => {
		setMode(modes[current].next);
	}}
	aria-label={mounted
		? `Тема оформления: ${modes[current].label}. Переключить на ${modes[modes[current].next].label}`
		: 'Тема оформления'}
	title={mounted ? `Тема: ${modes[current].label}` : undefined}
>
	<SunIcon class="hidden size-4 [[data-theme-mode=light]_&]:block" aria-hidden="true" />
	<MoonIcon class="hidden size-4 [[data-theme-mode=dark]_&]:block" aria-hidden="true" />
	<MonitorIcon class="size-4 [[data-theme-mode=dark]_&]:hidden [[data-theme-mode=light]_&]:hidden" aria-hidden="true" />
</Button>
