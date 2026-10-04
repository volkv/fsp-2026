<script lang="ts">
	import LockIcon from '@lucide/svelte/icons/lock';
	import * as Alert from '$lib/components/ui/alert/index.js';

	/**
	 * An action closed on the demonstration stand (domain 19.3): it would change what every visitor shares, so a demo
	 * account sees the screen but cannot act. `text` says what is closed here and why.
	 */
	let { text, class: className }: { text: string; class?: string } = $props();
</script>

<Alert.Root data-testid="demo-lock" class={className}>
	<LockIcon aria-hidden="true" />
	<Alert.Title>В демо недоступно</Alert.Title>
	<Alert.Description>{text}</Alert.Description>
</Alert.Root>
