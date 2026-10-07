<script lang="ts" module>
	export type ConversationClosure = 'not_accepted' | 'consent_revoked' | 'candidate_left' | 'company_closed';

	export interface ConversationMessage {
		id: string;
		side: 'candidate' | 'company';
		own: boolean;
		authorName: string | null;
		text: string;
		sentAt: Date;
		readAt: Date | null;
	}

	export interface Conversation {
		invitationId: string;
		viewer: 'candidate' | 'company';
		closure: ConversationClosure | null;
		messages: ConversationMessage[];
		unread: number;
	}
</script>

<script lang="ts">
	import SendIcon from '@lucide/svelte/icons/send';
	import { onMount } from 'svelte';
	import { deserialize, enhance } from '$app/forms';
	import { page } from '$app/state';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { CSRF_FIELD, viewerFrom } from '$lib/components/shell/viewer.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { cn } from '$lib/components/utils.js';
	import { formatDateTime } from './model.js';

	/**
	 * The conversation of an accepted offer: the messages of both sides, oldest first, and the form of a new one while
	 * the conversation is open. Texts are shown as text — no markup, links stay text. The page's form actions `message`
	 * and `readMessages` write; while the page is open and visible the conversation is read again every half minute.
	 */
	interface Props {
		conversation: Conversation;
		/** How the other side is named in the thread: the company's name, or the candidate's pseudonym. */
		otherName: string;
		/** Whose cabinet shows the thread: the candidate's or the company's. */
		reader: 'candidate' | 'company';
	}

	let { conversation, otherName, reader }: Props = $props();

	const MAX = 2000;
	const POLL_MS = 30_000;

	// What the last poll read, tied to the conversation the page loaded: a new load replaces it.
	let polled = $state<{ base: Conversation; data: Conversation } | null>(null);
	const shown = $derived(polled !== null && polled.base === conversation ? polled.data : conversation);
	let text = $state('');
	let problem = $state<string | null>(null);
	let sending = $state(false);

	const closedText = $derived.by(() => {
		switch (shown.closure) {
			case 'not_accepted':
				return reader === 'candidate'
					? 'Переписка откроется, когда вы примете приглашение.'
					: 'Переписка откроется, когда кандидат примет приглашение.';
			case 'consent_revoked':
				return 'Кандидат отозвал согласие на раскрытие контактов — переписка закрыта, история остаётся.';
			case 'candidate_left':
				return 'Профиль кандидата удаляется — переписка закрыта.';
			case 'company_closed':
				return 'Работа компании на платформе приостановлена — переписка закрыта, история остаётся.';
			case null:
				return null;
		}
	});

	function authorOf(message: ConversationMessage): string {
		if (message.own) return reader === 'candidate' ? 'Вы' : (message.authorName ?? 'Вы');
		if (message.side === 'company') return message.authorName ? `${message.authorName}, ${otherName}` : otherName;
		return otherName;
	}

	interface ApiConversation {
		invitation_id: string;
		viewer: 'candidate' | 'company';
		closure: ConversationClosure | null;
		unread: number;
		messages: {
			id: string;
			from: 'candidate' | 'company';
			own: boolean;
			author_name: string | null;
			text: string;
			sent_at: string;
			read_at: string | null;
		}[];
	}

	function fromApi(body: ApiConversation): Conversation {
		return {
			invitationId: body.invitation_id,
			viewer: body.viewer,
			closure: body.closure,
			unread: body.unread,
			messages: body.messages.map((message) => ({
				id: message.id,
				side: message.from,
				own: message.own,
				authorName: message.author_name,
				text: message.text,
				sentAt: new Date(message.sent_at),
				readAt: message.read_at === null ? null : new Date(message.read_at)
			}))
		};
	}

	/** The other side's messages are read once the conversation is open in the browser; a preload does not count. */
	async function markRead(): Promise<void> {
		const viewer = viewerFrom(page.data);
		if (!viewer) return;
		const body = new FormData();
		body.set(CSRF_FIELD, viewer.csrfToken);
		const response = await fetch('?/readMessages', {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		if (result.type === 'error') throw new Error('the conversation was not marked read');
	}

	async function poll(): Promise<void> {
		const base = conversation;
		const response = await fetch(`/api/v1/invitations/${base.invitationId}/messages`, {
			headers: { accept: 'application/json' }
		});
		if (!response.ok) throw new Error(`the conversation was not read: ${response.status}`);
		const data = fromApi((await response.json()) as ApiConversation);
		polled = { base, data };
		if (data.unread > 0) await markRead();
	}

	onMount(() => {
		if (conversation.unread > 0) void markRead();
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void poll();
		}, POLL_MS);
		return () => {
			clearInterval(timer);
		};
	});
</script>

<div class="grid gap-4" data-testid="offer-conversation">
	{#if shown.messages.length === 0}
		<p class="text-sm text-muted-foreground">
			{shown.closure === null
				? reader === 'candidate'
					? 'Сообщений пока нет. Можно договориться о созвоне или задать вопрос по условиям.'
					: 'Сообщений пока нет. Можно договориться о собеседовании или ответить на вопросы кандидата.'
				: 'Сообщений нет.'}
		</p>
	{:else}
		<ol class="grid gap-3" aria-label="Сообщения">
			{#each shown.messages as message (message.id)}
				<li
					class={cn(
						'grid max-w-[85%] gap-1 rounded-lg border px-3 py-2',
						message.own ? 'justify-self-end bg-muted' : 'justify-self-start bg-card',
						!message.own && message.readAt === null && 'border-primary/50'
					)}
					data-testid="offer-message"
					data-side={message.side}
				>
					<p class="text-xs text-muted-foreground">
						<span class="font-medium text-foreground">{authorOf(message)}</span>
						· <time datetime={message.sentAt.toISOString()}>{formatDateTime(message.sentAt)}</time>
						{#if message.own}
							· {message.readAt === null ? 'не прочитано' : 'прочитано'}
						{:else if message.readAt === null}
							· <span class="text-primary">новое</span>
						{/if}
					</p>
					<p class="text-sm break-words whitespace-pre-wrap">{message.text}</p>
				</li>
			{/each}
		</ol>
	{/if}

	{#if closedText}
		<p class="text-sm text-muted-foreground" data-testid="conversation-closed">{closedText}</p>
	{:else}
		{#if problem}<FormMessage text={problem} />{/if}
		<form
			method="POST"
			action="?/message"
			class="grid gap-2"
			use:enhance={() => {
				sending = true;
				return async ({ result, update }) => {
					sending = false;
					if (result.type === 'failure') {
						const failure = result.data?.problem as { message?: string } | undefined;
						problem = failure?.message ?? 'Сообщение не отправлено.';
						return;
					}
					problem = null;
					text = '';
					await update({ reset: false });
				};
			}}
		>
			<CsrfInput />
			<label class="sr-only" for="offer-message-text">Текст в переписку</label>
			<Textarea
				id="offer-message-text"
				name="text"
				bind:value={text}
				maxlength={MAX}
				rows={3}
				required
				placeholder={reader === 'candidate' ? 'Напишите компании' : 'Напишите кандидату'}
			/>
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="text-xs text-muted-foreground">
					{text.length}/{MAX}. Без вложений; ссылки остаются текстом. Уведомление о сообщении придёт без его текста.
				</p>
				<Button type="submit" size="sm" disabled={sending || text.trim().length === 0}>
					<SendIcon aria-hidden="true" />
					Отправить
				</Button>
			</div>
		</form>
	{/if}
</div>
