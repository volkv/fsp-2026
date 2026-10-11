<script lang="ts">
	import { cn } from '$lib/components/utils.js';
	import { isActive, type NavItem } from '$lib/navigation.js';

	interface Props {
		items: NavItem[];
		pathname: string;
		vertical?: boolean;
		onnavigate?: () => void;
	}

	let { items, pathname, vertical = false, onnavigate }: Props = $props();

	const itemClass = $derived(
		cn(
			'inline-flex items-center gap-2 rounded-md py-2 text-sm font-medium whitespace-nowrap transition-colors',
			vertical ? 'w-full px-3' : 'px-2.5'
		)
	);
</script>

<ul class={cn('flex', vertical ? 'flex-col gap-1' : 'items-center gap-1')}>
	{#each items as item (item.href)}
		{@const active = isActive(pathname, item)}
		<li>
			<a
				href={item.href}
				class={cn(
					itemClass,
					'hover:bg-muted',
					active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
				)}
				aria-current={active ? 'page' : undefined}
				data-tour="nav:{item.href}"
				onclick={onnavigate}
			>
				<item.icon class="size-4" aria-hidden="true" />
				{item.label}
			</a>
		</li>
	{/each}
</ul>
