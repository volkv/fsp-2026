<script lang="ts">
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import LinkIcon from '@lucide/svelte/icons/link';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ReceiptIcon from '@lucide/svelte/icons/receipt-text';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { enhance } from '$app/forms';
	import CsrfInput from '$lib/components/forms/csrf-input.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import { TrustChip, VerificationReceipt } from '$lib/components/product/index.js';
	import { formatDate, formatDateTime, type ReceiptView } from '$lib/components/product/model.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import ProfileForm from './external-profile-form.svelte';
	import ProfileUnlink from './external-profile-unlink.svelte';
	import {
		assertion,
		EXTERNAL_PLATFORMS,
		SOURCE_FAILURES,
		type ExternalPlatform,
		type ExternalProfileView
	} from './model.js';

	/**
	 * The public profiles of the candidate: linking by a one-time code, the check, the state of the last reading and
	 * what it found, a new reading and unlinking. `result` — the outcome of the last action, told next to its target.
	 */
	let {
		profiles,
		result
	}: {
		profiles: ExternalProfileView[];
		result: {
			target: string;
			message?: { ok: boolean; text: string };
			problem?: { message: string; fields: Record<string, string> };
		} | null;
	} = $props();

	const free = $derived(
		(Object.keys(EXTERNAL_PLATFORMS) as ExternalPlatform[]).filter((p) => !profiles.some((x) => x.platform === p))
	);
	let linking = $state(false);

	const selectClass =
		'h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

	/** The outcome of the last action if it is about `target`. */
	function outcomeOf(target: string): { tone: 'error' | 'success'; text: string } | null {
		if (result?.target !== target) return null;
		if (result.problem) return { tone: 'error', text: result.problem.message };
		if (result.message) return { tone: result.message.ok ? 'success' : 'error', text: result.message.text };
		return null;
	}

	/** The candidate's own receipt of the current fact of a profile, in the shape of the receipt component. */
	function receiptOf(profile: ExternalProfileView): ReceiptView | null {
		const receipt = profile.receipt;
		if (receipt === null) return null;
		return {
			handle: receipt.handle,
			source: profile.platform,
			title: `${EXTERNAL_PLATFORMS[profile.platform].name} ${profile.handle}`,
			verifiedAt: receipt.verifiedAt,
			status: receipt.status,
			disclosure: 'generalized',
			asserts: Object.entries(receipt.asserts).map(([key, value]) => assertion(key, value)),
			doesNotAssert: receipt.doesNotAssert,
			signingKeyId: receipt.signingKeyId
		};
	}

	const percent = (share: number) => `${Math.round(share * 100)}%`;
	const monthName = (month: string) =>
		new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
			new Date(`${month}-01T00:00:00Z`)
		);
	const handleProblem = $derived(result?.target === 'link' ? result.problem?.fields.handle : undefined);
	const linkOutcome = $derived(handleProblem === undefined ? outcomeOf('link') : null);
</script>

<div class="grid gap-4">
	{#if profiles.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2">
			{#each profiles as profile (profile.id)}
				{@const platform = EXTERNAL_PLATFORMS[profile.platform]}
				<li
					id={profile.factId === null ? undefined : `fact-${profile.factId}`}
					class="grid scroll-mt-32 content-start gap-3 rounded-xl border bg-card p-4 shadow-xs"
					data-testid="external-profile"
					data-platform={profile.platform}
					data-status={profile.status}
					data-sync={profile.syncStatus ?? 'none'}
				>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="grid gap-0.5">
							<p class="text-xs text-muted-foreground">{platform.name}</p>
							<a
								class="inline-flex items-center gap-1 font-medium text-link underline-offset-4 hover:underline"
								href={platform.profileUrl(profile.handle)}
								target="_blank"
								rel="external noopener noreferrer"
							>
								{profile.handle}
								<ExternalLinkIcon class="size-3.5" aria-hidden="true" />
							</a>
						</div>
						{#if profile.status === 'verified'}
							<TrustChip level="public_verifiable" size="md" />
						{:else}
							<TrustChip level="claimed" size="md" />
						{/if}
					</div>

					{#if profile.status === 'verified'}
						<dl class="grid gap-1 text-sm">
							<div class="flex flex-wrap gap-x-1.5">
								<dt class="text-muted-foreground">Владение подтверждено:</dt>
								<dd>{profile.verifiedAt ? formatDate(profile.verifiedAt) : '—'}</dd>
							</div>
							<div class="flex flex-wrap gap-x-1.5">
								<dt class="text-muted-foreground">Сверено:</dt>
								<dd data-testid="synced-at">{profile.syncedAt ? formatDateTime(profile.syncedAt) : 'ещё нет'}</dd>
							</div>
						</dl>

						{#if profile.syncStatus === 'source_unavailable'}
							<p class="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-warning" role="status">
								<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								<span>
									Источник недоступен: при сверке {profile.syncCheckedAt ? formatDateTime(profile.syncCheckedAt) : ''}
									{platform.name}
									{SOURCE_FAILURES[profile.syncError ?? ''] ?? 'не ответил'}.
									{profile.summary ? 'Ниже — данные последней удачной сверки.' : 'Данных профиля пока нет.'} Сверим снова
									сами.
								</span>
							</p>
						{:else if profile.syncStatus === 'not_found'}
							<p class="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-warning" role="status">
								<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								<span>{platform.name} больше не находит этот аккаунт: его данные выведены из профиля.</span>
							</p>
						{/if}

						{#if profile.summary?.kind === 'codeforces'}
							{@const cf = profile.summary.data}
							<dl class="grid gap-1 text-sm" data-testid="profile-summary">
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Рейтинг:</dt>
									<dd>
										{cf.account.rating ?? 'нет'}{cf.maxRating !== null ? ` (максимум ${cf.maxRating})` : ''}
									</dd>
								</div>
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Ранг:</dt>
									<dd>{cf.rank ?? 'нет'}</dd>
								</div>
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Решено задач:</dt>
									<dd>{cf.solvedCount}</dd>
								</div>
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Рейтинговых контестов:</dt>
									<dd>
										{cf.ratedContests}{cf.lastRatedOn ? `, последний ${formatDate(cf.lastRatedOn)}` : ''}
									</dd>
								</div>
							</dl>
						{:else if profile.summary?.kind === 'github'}
							{@const gh = profile.summary.data}
							<dl class="grid gap-1 text-sm" data-testid="profile-summary">
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Языки репозиториев:</dt>
									<dd>
										{gh.languages.length === 0
											? 'не определены'
											: gh.languages.map((l) => `${l.name} ${percent(l.share)}`).join(' · ')}
									</dd>
								</div>
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Репозитории:</dt>
									<dd>
										{gh.publicRepos} публичных, {gh.ownRepos} своих без форков; языки — по {gh.reposRead} последним
									</dd>
								</div>
								<div class="flex flex-wrap gap-x-1.5">
									<dt class="text-muted-foreground">Активность:</dt>
									<dd>
										{gh.lastPushMonth ? `последний push — ${monthName(gh.lastPushMonth)}` : 'push нет'}, за год
										обновлено
										{gh.reposPushedLastYear}
									</dd>
								</div>
							</dl>
							<p class="text-xs text-muted-foreground">
								Это языки публичных репозиториев, а не подтверждение авторства каждой строки: в репозитории может быть и
								чужой код.
							</p>
						{/if}

						{@const receipt = receiptOf(profile)}
						{#if receipt}
							<details class="group rounded-lg border" data-testid="profile-receipt">
								<summary
									class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
								>
									<ReceiptIcon class="size-4 text-link" aria-hidden="true" />
									Квитанция проверки: что подтверждено и чего нет
								</summary>
								<div class="p-3 pt-0">
									<VerificationReceipt {receipt} class="border-0 shadow-none" />
								</div>
							</details>
						{/if}
						{@const outcome = outcomeOf(`profile:${profile.id}`)}
						{#if outcome}<FormMessage tone={outcome.tone} text={outcome.text} />{/if}
						<div class="flex flex-wrap gap-2">
							<ProfileForm {profile} action="refreshProfile">
								<RefreshCwIcon aria-hidden="true" />
								Сверить сейчас
							</ProfileForm>
							<ProfileUnlink {profile} />
						</div>
					{:else}
						{#if profile.challenge}
							<div class="grid gap-2 text-sm">
								<p>
									Одноразовый код:
									<code
										class="rounded bg-muted px-1.5 py-0.5 font-mono text-base select-all"
										data-testid="challenge-code">{profile.challenge.code}</code
									>
								</p>
								{#if profile.platform === 'codeforces'}
									<p class="text-muted-foreground">
										Откройте <a
											class="text-link underline underline-offset-4"
											href="https://codeforces.com/settings/social"
											target="_blank"
											rel="external noopener noreferrer">настройки Codeforces</a
										>, впишите код в поле имени, фамилии или организации и сохраните. Потом нажмите «Проверить» — код
										можно будет убрать.
									</p>
								{:else}
									<p class="text-muted-foreground">
										Создайте публичный <a
											class="text-link underline underline-offset-4"
											href="https://gist.github.com/"
											target="_blank"
											rel="external noopener noreferrer">gist</a
										>
										с кодом в описании или в имени файла — или добавьте код в README репозитория
										<span class="font-mono">{profile.handle}/{profile.handle}</span>. Потом нажмите «Проверить».
									</p>
								{/if}
								<p class="text-xs text-muted-foreground">
									Код действует до {formatDateTime(profile.challenge.expiresAt)}, проверок осталось: {profile.challenge
										.attemptsLeft}.
								</p>
							</div>
							{@const outcome = outcomeOf(`profile:${profile.id}`)}
							{#if outcome}<FormMessage tone={outcome.tone} text={outcome.text} />{/if}
							<div class="flex flex-wrap gap-2">
								<ProfileForm {profile} action="confirmProfile" variant="default" pendingLabel="Проверяем…"
									>Проверить</ProfileForm
								>
								<ProfileForm {profile} action="linkProfile">Новый код</ProfileForm>
								<ProfileUnlink {profile} />
							</div>
						{:else}
							<p class="text-sm text-muted-foreground">
								Владение не подтверждено: профиль не учитывается, пока в нём не найден одноразовый код.
							</p>
							{@const outcome = outcomeOf(`profile:${profile.id}`)}
							{#if outcome}<FormMessage tone={outcome.tone} text={outcome.text} />{/if}
							<div class="flex flex-wrap gap-2">
								<ProfileForm {profile} action="linkProfile">Получить код</ProfileForm>
								<ProfileUnlink {profile} />
							</div>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if free.length > 0}
		<form
			method="POST"
			action="?/linkProfile"
			class="grid gap-3 rounded-xl border border-dashed p-4"
			use:enhance={() => {
				linking = true;
				return async ({ update }) => {
					await update();
					linking = false;
				};
			}}
			data-testid="external-profile-link"
		>
			<CsrfInput />
			<p class="text-sm font-medium">Привязать профиль</p>
			<div class="flex flex-wrap items-end gap-3">
				<label class="grid gap-1.5 text-sm">
					<span>Платформа</span>
					<select name="platform" class={selectClass}>
						{#each free as platform (platform)}
							<option value={platform}>{EXTERNAL_PLATFORMS[platform].name}</option>
						{/each}
					</select>
				</label>
				<label class="grid min-w-56 flex-1 gap-1.5 text-sm">
					<span>Хэндл или ссылка на профиль</span>
					<Input
						name="handle"
						required
						autocomplete="off"
						aria-invalid={handleProblem === undefined ? undefined : true}
					/>
				</label>
				<Button type="submit" disabled={linking}>
					<LinkIcon aria-hidden="true" />
					Получить код
				</Button>
			</div>
			{#if handleProblem !== undefined}
				<p class="text-sm text-destructive">{handleProblem}</p>
			{/if}
		</form>
	{/if}
	{#if linkOutcome}<FormMessage tone={linkOutcome.tone} text={linkOutcome.text} />{/if}
</div>
