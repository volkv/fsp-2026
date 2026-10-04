<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	const trustChipVariants = tv({
		base: 'inline-flex max-w-full items-center gap-1.5 rounded-full border text-xs leading-none font-medium whitespace-nowrap select-none',
		variants: {
			level: {
				fsp_verified: 'border-trust-fsp bg-trust-fsp text-trust-fsp-foreground',
				platform_verified: 'border-trust-platform-border bg-trust-platform text-trust-platform-foreground',
				public_verifiable: 'border-trust-public-border bg-trust-public text-trust-public-foreground',
				claimed: 'border-dashed border-trust-claimed-border bg-transparent text-trust-claimed-foreground',
				derived: 'border-transparent bg-transparent px-0! text-muted-foreground'
			},
			size: {
				sm: 'h-6 px-2',
				md: 'h-7 px-2.5 text-sm'
			}
		},
		defaultVariants: { level: 'claimed', size: 'sm' }
	});

	type TrustChipSize = VariantProps<typeof trustChipVariants>['size'];
</script>

<script lang="ts">
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PenLineIcon from '@lucide/svelte/icons/pen-line';
	import * as Tooltip from '$lib/components/ui/tooltip/index.js';
	import { cn } from '$lib/components/utils.js';
	import { TRUST, type Register, type TrustMark } from './model.js';
	import TrustSignal from './trust-signal.svelte';

	interface Props {
		level: TrustMark;
		/** Skill the mark belongs to; shown before the level. */
		skill?: string;
		register?: Register;
		size?: TrustChipSize;
		/** Adds the three-node signal after the label. */
		signal?: boolean;
		/** Replace the generic "confirms / does not confirm" texts with the ones of a concrete fact (receipt template). */
		asserts?: string;
		doesNotAssert?: string;
		class?: string;
	}

	let {
		level,
		skill,
		register = 'hr',
		size = 'sm',
		signal = false,
		asserts,
		doesNotAssert,
		class: className
	}: Props = $props();

	const icons = {
		fsp_verified: BadgeCheckIcon,
		platform_verified: ClipboardCheckIcon,
		public_verifiable: GlobeIcon,
		claimed: PenLineIcon,
		derived: GitBranchIcon
	} as const;

	const meta = $derived(TRUST[level]);
	const label = $derived(register === 'sport' ? meta.sportLabel : meta.label);
	const shown = $derived(skill ? (level === 'derived' ? `${skill} · вывод` : `${skill} · ${meta.short}`) : label);
	const accessibleName = $derived(skill ? `${skill}: ${meta.label}` : meta.label);
	const Icon = $derived(icons[level]);
</script>

<Tooltip.Root>
	<Tooltip.Trigger
		class={cn(
			trustChipVariants({ level, size }),
			'cursor-help focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
			className
		)}
		aria-label={accessibleName}
		data-trust={level}
	>
		<Icon class="size-3.5 shrink-0" aria-hidden="true" />
		<span class="truncate">{shown}</span>
		{#if signal && level !== 'derived'}
			<TrustSignal filled={meta.nodes} />
		{/if}
	</Tooltip.Trigger>
	<Tooltip.Content class="block max-w-xs space-y-1.5 px-3 py-2 text-left leading-snug">
		<p class="font-semibold">{meta.label}</p>
		<p><span class="opacity-80">Подтверждает:</span> {asserts ?? meta.asserts}</p>
		<p><span class="opacity-80">Не подтверждает:</span> {doesNotAssert ?? meta.doesNotAssert}</p>
	</Tooltip.Content>
</Tooltip.Root>
