<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/components/utils.js';
	import { buttonVariants, type ButtonSize, type ButtonVariant } from './variants.js';

	/** Links styled as buttons use `buttonVariants` on an `<a>` with a resolved route. */
	type Props = WithElementRef<HTMLButtonAttributes> & {
		variant?: ButtonVariant;
		size?: ButtonSize;
	};

	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		type = 'button',
		disabled,
		children,
		...restProps
	}: Props = $props();
</script>

<button
	bind:this={ref}
	data-slot="button"
	class={cn(buttonVariants({ variant, size }), className)}
	{type}
	{disabled}
	{...restProps}
>
	{@render children?.()}
</button>
