<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { tick } from 'svelte';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ResumeClaimView } from '$lib/components/candidate/quotes';
	import ProfileSuggestion from '$lib/components/candidate/profile-suggestion.svelte';
	import ResumeClaim from '$lib/components/candidate/resume-claim.svelte';
	import ResumeDocument from '$lib/components/candidate/resume-document.svelte';
	import ResumeEntry from '$lib/components/candidate/resume-entry.svelte';
	import ResumeReading from '$lib/components/candidate/resume-reading.svelte';
	import ResumeUpload from '$lib/components/candidate/resume-upload.svelte';
	import ResumeUploads from '$lib/components/candidate/resume-uploads.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import FormMessage from '$lib/components/forms/form-message.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const current = $derived(data.current);
	const resumeText = $derived(current?.document ?? null);
	const located = $derived(new Set(resumeText?.located ?? []));
	const failure = $derived(form && 'problem' in form ? form : null);
	const problemOf = (target: string) => (failure?.target === target ? failure.problem : null);
	const deleteProblem = $derived(problemOf('delete'));

	// The parse and the extraction run in the background: the page asks again until the reading is known.
	$effect(() => {
		if (!data.inProgress) return;
		const timer = setInterval(() => void invalidate('app:me-resume'), 3000);
		return () => {
			clearInterval(timer);
		};
	});

	/** Fields that make up an experience entry itself; the entry card shows and reviews them as one. */
	const ENTRY_FIELDS = new Set(['role_title', 'organization', 'experience_period']);
	const GROUPS: { title: string; types: string[] }[] = [
		{ title: 'Навыки', types: ['skill_mention'] },
		{ title: 'Языки', types: ['language_level'] },
		{ title: 'Образование', types: ['education'] },
		{ title: 'Достижения', types: ['achievement_mention'] },
		{
			title: 'Другое',
			types: ['team_role', 'responsibility_marker', 'role_title', 'organization', 'experience_period']
		}
	];

	const entryIds = $derived(new Set(current?.experience.map((entry) => entry.id) ?? []));
	const inEntry = (claim: ResumeClaimView) => claim.experienceEntryId !== null && entryIds.has(claim.experienceEntryId);
	const standalone = $derived((current?.claims ?? []).filter((claim) => !inEntry(claim)));
	const groups = $derived(
		GROUPS.map((group) => ({
			...group,
			claims: standalone.filter((claim) => group.types.includes(claim.claimType))
		})).filter((group) => group.claims.length > 0)
	);
	const entryClaims = (entryId: string) =>
		(current?.claims ?? []).filter(
			(claim) => claim.experienceEntryId === entryId && !ENTRY_FIELDS.has(claim.claimType)
		);

	const documentId = 'resume-document';
	const documentHeadingId = 'resume-document-heading';
	let documentElement = $state<HTMLElement | null>(null);
	let selected = $state<string | null>(null);

	/** Shows the quotes of a field in the text: selects them, scrolls to the first one and moves focus there. */
	async function show(key: string) {
		selected = key;
		await tick();
		const mark = documentElement?.querySelector<HTMLElement>(`mark[data-sources~="${CSS.escape(key)}"]`);
		if (!mark) throw new Error(`no quote of ${key} is marked in the document`);
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		mark.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
		mark.focus({ preventScroll: true });
	}
</script>

<PageHeader
	title="Резюме"
	description="Загрузи резюме — мы разберём его сами. У каждого поля есть цитата: видно, откуда оно взялось. Проверь, что нашлось, подтверди верное и поправь неточное — опыт работы из резюме нужен для грейда."
>
	{#snippet eyebrow()}<a class="underline underline-offset-4" href={resolve('/me/profile')}>Профиль</a>{/snippet}
</PageHeader>

{#if deleteProblem}
	<FormMessage text={deleteProblem.message} />
{:else if form && 'deleted' in form}
	<FormMessage tone="success" text="Резюме удалено вместе со всем, что из него извлечено." />
{/if}

<SectionCard
	title={current ? 'Загрузить новую версию' : 'Загрузить резюме'}
	description="Сам файл работодатель получит, только если ты раскроешь его, принимая приглашение."
>
	{#if data.processingRefusal}
		<div data-testid="resume-consent-required">
			<FormMessage text={data.processingRefusal} />
		</div>
	{:else}
		<ResumeUpload
			problem={problemOf('upload')}
			uploaded={Boolean(form && 'uploaded' in form)}
			hasCurrent={current !== null}
		/>
	{/if}
</SectionCard>

{#if data.uploads.length > 0}
	<SectionCard title="Мои файлы" testId="resume-files">
		<ResumeUploads uploads={data.uploads} extracting={data.inProgress && current?.upload.parseStatus !== 'pending'} />
	</SectionCard>
{/if}

{#if current === null}
	<Empty.Root class="border p-8">
		<Empty.Header>
			<Empty.Media variant="icon"><FileTextIcon aria-hidden="true" /></Empty.Media>
			<Empty.Title>Резюме пока нет</Empty.Title>
			<Empty.Description>
				Загрузи файл — мы найдём в нём опыт работы, навыки и языки. Каждое поле будет с цитатой из твоего документа, а
				решать, что верно, будешь ты.
			</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if data.inProgress}
	<div
		class="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs"
		role="status"
		data-testid="resume-progress"
	>
		<Spinner aria-hidden="true" role="presentation" class="size-5 text-info" />
		<p>
			{current.upload.parseStatus === 'pending'
				? 'Читаем файл «' + current.upload.declaredName + '»…'
				: 'Текст прочитан, ищем в нём опыт и навыки…'}
			Страница обновится сама.
		</p>
	</div>
{:else if current.upload.failureMessage}
	<FormMessage text={current.upload.failureMessage} />
{:else if resumeText}
	{#if current.reading}
		<ResumeReading
			mode={current.reading.processingMode}
			ocrUsed={resumeText.flags.ocrUsed}
			incomplete={resumeText.flags.incomplete}
		/>
	{/if}

	<div class="grid items-start gap-8 lg:grid-cols-2">
		<div class="grid gap-8">
			<SectionCard
				title="Опыт работы"
				description="Каждое место работы с должностью, компанией и периодом. Подтверждённый опыт с датами — основание грейда."
				testId="resume-experience"
			>
				{#if current.experience.length > 0}
					<div class="grid gap-4">
						{#each current.experience as entry (entry.id)}
							{@const target = `entry:${entry.id}`}
							<ResumeEntry
								{entry}
								labels={data.labels}
								roles={data.roles}
								located={located.has(entry.sourceKey)}
								selected={selected === entry.sourceKey}
								{documentId}
								problem={problemOf(target)}
								correcting={failure?.target === target && 'correcting' in failure}
								onshow={show}
							>
								{#if entryClaims(entry.id).length > 0}
									<ul class="grid gap-2" aria-label="Другие поля этой работы">
										{#each entryClaims(entry.id) as claim (claim.id)}
											<li>
												<ResumeClaim
													{claim}
													labels={data.labels}
													located={located.has(claim.sourceKey)}
													selected={selected === claim.sourceKey}
													{documentId}
													problem={problemOf(claim.sourceKey)?.message ?? null}
													onshow={show}
												/>
											</li>
										{/each}
									</ul>
								{/if}
							</ResumeEntry>
						{/each}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">
						Опыт работы в резюме не нашёлся. Если он там есть, проверь, что у мест работы указаны должность и период —
						например, «Март 2021 — настоящее время».
					</p>
				{/if}
			</SectionCard>

			<SectionCard
				title="Навыки и другие поля"
				description="Навыки из резюме отмечаются в профиле как заявленные: подтвердить их уровень помогут тесты и достижения ФСП."
				testId="resume-claims"
			>
				{#if groups.length > 0}
					{#each groups as group (group.title)}
						<div class="grid gap-2">
							<h3 class="text-sm font-medium">{group.title}</h3>
							<ul class="grid gap-2">
								{#each group.claims as claim (claim.id)}
									<li>
										<ResumeClaim
											{claim}
											labels={data.labels}
											located={located.has(claim.sourceKey)}
											selected={selected === claim.sourceKey}
											{documentId}
											problem={problemOf(claim.sourceKey)?.message ?? null}
											onshow={show}
										/>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				{:else}
					<p class="text-sm text-muted-foreground">Других полей в резюме не нашлось.</p>
				{/if}
			</SectionCard>

			{#if current.suggestions.length > 0}
				<SectionCard
					title="Для полей профиля"
					description="ФИО, контакты и мягкие навыки, найденные в резюме. Принятое значение записывается в профиль; поправить его можно на странице профиля. В подбор и к работодателю эти поля из резюме не попадают."
					testId="resume-profile-suggestions"
				>
					<ul class="grid gap-2">
						{#each current.suggestions as suggestion (suggestion.id)}
							<ProfileSuggestion
								{suggestion}
								accountEmail={data.accountEmail}
								problem={problemOf(suggestion.sourceKey)?.message ?? null}
								onshow={show}
							/>
						{/each}
					</ul>
				</SectionCard>
			{/if}
		</div>

		<section
			id={documentId}
			aria-labelledby={documentHeadingId}
			class="grid gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:p-6 lg:sticky lg:top-4"
		>
			<div class="grid gap-1">
				<h2 id={documentHeadingId} class="font-heading text-h3">Текст резюме</h2>
				<p class="text-sm text-muted-foreground">
					Так мы прочитали файл «{current.upload.declaredName}». Отмечены слова, на которые опираются поля; нажми на
					цитату у поля — она подсветится здесь.
				</p>
			</div>
			<ResumeDocument
				blocks={resumeText.blocks}
				{selected}
				bind:element={documentElement}
				labelledby={documentHeadingId}
			/>
		</section>
	</div>
{/if}
