<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleSlashIcon from '@lucide/svelte/icons/circle-slash';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import HourglassIcon from '@lucide/svelte/icons/hourglass';
	import SendIcon from '@lucide/svelte/icons/send';
	import UndoIcon from '@lucide/svelte/icons/undo-2';
	import { cn } from '$lib/components/utils.js';
	import { INVITATION_STATUSES, type InvitationStatus } from './model.js';

	let { status, class: className }: { status: InvitationStatus; class?: string } = $props();

	const styles: Record<InvitationStatus, string> = {
		sent: 'border-primary/30 bg-accent text-accent-foreground',
		viewed: 'border-primary/30 bg-accent text-accent-foreground',
		accepted: 'border-success/40 bg-success-subtle text-success',
		declined: 'border-destructive/40 bg-danger-subtle text-destructive',
		expired: 'border-border bg-muted text-muted-foreground',
		withdrawn: 'border-border bg-muted text-muted-foreground'
	};

	const icons = {
		sent: SendIcon,
		viewed: EyeIcon,
		accepted: CheckIcon,
		declined: CircleSlashIcon,
		expired: HourglassIcon,
		withdrawn: UndoIcon
	} as const;

	const Icon = $derived(icons[status]);
</script>

<span
	class={cn(
		'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap',
		styles[status],
		className
	)}
	data-invitation-status={status}
>
	<Icon class="size-3.5" aria-hidden="true" />
	{INVITATION_STATUSES[status]}
</span>
