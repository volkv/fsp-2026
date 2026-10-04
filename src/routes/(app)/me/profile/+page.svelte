<script lang="ts">
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import LinkIcon from '@lucide/svelte/icons/link';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import { resolve } from '$app/paths';
	import ExternalProfiles from '$lib/components/candidate/external-profiles.svelte';
	import FactCard from '$lib/components/candidate/fact-card.svelte';
	import { SEARCH_STATUSES, type FactSource, type FactView } from '$lib/components/candidate/model.js';
	import ResumeSummary from '$lib/components/candidate/resume-summary.svelte';
	import SectionCard from '$lib/components/candidate/section-card.svelte';
	import SkillList from '$lib/components/candidate/skill-list.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { InsufficientData } from '$lib/components/product/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let resumeSummary = $state<{ show: (sourceKey: string) => Promise<void> }>();
	/** A skill resting on a field of the resume selects its quote in the resume below. */
	function showResumeField(sourceKey: string): Promise<void> {
		if (!resumeSummary) throw new Error('the resume is not on the page');
		return resumeSummary.show(sourceKey);
	}

	const evidence = $derived(data.evidence);

	/**
	 * Every fact of the profile has its place on the page, by its source: a skill names the facts it rests on and opens
	 * them by their anchors, so no fact may be left without one.
	 */
	const SECTIONS: Record<FactSource, 'fsp' | 'tests' | 'public' | 'resume' | 'declared'> = {
		fsp: 'fsp',
		platform_test: 'tests',
		codeforces: 'public',
		github: 'public',
		resume: 'resume',
		self_declared: 'declared'
	};
	const factsOf = (section: (typeof SECTIONS)[FactSource]): FactView[] =>
		evidence.facts.filter((fact) => SECTIONS[fact.source] === section);
	const fspFacts = $derived(factsOf('fsp'));
	const testFacts = $derived(factsOf('tests'));
	// A public profile shows its current fact in its own card, with the state of ownership and of the last reading;
	// a fact of a public profile without such a card is shown on its own.
	const profileFactIds = $derived(new Set(data.externalProfiles.map((profile) => profile.factId)));
	const publicFacts = $derived(factsOf('public').filter((fact) => !profileFactIds.has(fact.id)));
	// An upload supersedes the fact of the previous resume, so the one resume fact in force is the current resume's.
	const [resumeFact = null, ...otherResumeFacts] = $derived(factsOf('resume'));
	const declaredFacts = $derived([...otherResumeFacts, ...factsOf('declared')]);
	const profileResult = $derived(form && 'target' in form ? form : null);

	const CONSENT_STATES = {
		effective: 'Действует',
		representative_received: 'Действует: согласие представителя получено',
		representative_pending: 'Согласие представителя ожидается',
		representative_missing: 'Нужен законный представитель',
		own_missing: 'Нужна твоя подпись: после 18 лет согласие подтверждается заново'
	} as const;
</script>

<PageHeader
	title="Твой профиль"
	description="Твои победы засчитываются в карьере: профиль собирается сам из проверяемых фактов. Здесь видно, что подтверждено, откуда это взялось и чего не хватает."
>
	{#snippet eyebrow()}{evidence.displayName}{/snippet}
	{#snippet actions()}
		<a href={resolve('/me/category')} class={buttonVariants({ variant: 'outline' })}>Категория</a>
		<a href={resolve('/me/settings')} class={buttonVariants({ variant: 'outline' })}>Предпочтения</a>
	{/snippet}
</PageHeader>

<dl class="grid gap-3 sm:grid-cols-2" aria-label="Статус профиля">
	<div class="rounded-lg border p-3">
		<dt class="text-xs text-muted-foreground">Поиск работы</dt>
		<dd class="flex flex-wrap items-center justify-between gap-2">
			<span class="font-medium">{SEARCH_STATUSES[evidence.searchStatus].label}</span>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/vacancies')}>изменить</a>
		</dd>
	</div>
	<div class="rounded-lg border p-3">
		<dt class="text-xs text-muted-foreground">Показ работодателям</dt>
		<dd class="flex flex-wrap items-center justify-between gap-2">
			<span class="font-medium">{evidence.visibility === 'catalog' ? 'Включён' : 'Выключен'}</span>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/visibility')}>видимость и согласия</a
			>
		</dd>
	</div>
	<div class="rounded-lg border p-3 sm:col-span-2" data-testid="consent-state" data-state={data.consent}>
		<dt class="text-xs text-muted-foreground">Согласие на обработку данных</dt>
		<dd class="flex flex-wrap items-center justify-between gap-2">
			<span class="font-medium">{CONSENT_STATES[data.consent]}</span>
			<a class="text-sm text-link underline underline-offset-4" href={resolve('/me/consents')}>согласия</a>
		</dd>
	</div>
</dl>

<SectionCard
	title="Достижения ФСП"
	description="ФСП подтверждает факт: соревнование, результат, роль. Что именно факт подтверждает, а чего нет — в квитанции проверки."
	testId="fsp-achievements"
>
	{#if fspFacts.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2">
			{#each fspFacts as fact (fact.id)}
				<li id="fact-{fact.id}" class="scroll-mt-32">
					<FactCard {fact} labels={evidence.labels} />
				</li>
			{/each}
		</ul>
	{:else}
		<Empty.Root class="border p-8">
			<Empty.Header>
				<Empty.Media variant="icon"><TrophyIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Достижений ФСП в профиле пока нет</Empty.Title>
				<Empty.Description>
					{#if data.fspStep === 'link'}
						Привяжи ФСП ID, затем дай отдельное согласие на импорт — результаты, разряды и членство в сборной подтянутся
						сами, с квитанциями проверки.
					{:else if data.fspStep === 'import'}
						ФСП ID привязан. Дай отдельное согласие на импорт — результаты соревнований подтянутся сами.
					{:else if data.fspStep === 'unavailable'}
						Вход через ФСП ID на этой установке не настроен: импорт достижений недоступен.
					{:else}
						Импорт по твоему согласию включён. Если результаты ещё загружаются или в ФСП их нет, список пуст.
					{/if}
				</Empty.Description>
			</Empty.Header>
			{#if data.fspStep === 'link'}
				<Empty.Content>
					<a href={resolve('/account')} class={buttonVariants()}>
						<LinkIcon aria-hidden="true" />
						Привязать ФСП ID
					</a>
				</Empty.Content>
			{:else if data.fspStep === 'import'}
				<Empty.Content>
					<a href={resolve('/account/fsp-import')} class={buttonVariants()}>
						<TrophyIcon aria-hidden="true" />
						Подтвердить достижения из ФСП
					</a>
				</Empty.Content>
			{/if}
		</Empty.Root>
	{/if}
</SectionCard>

<SectionCard
	title="Навыки"
	description="У каждого навыка — уровень доверия и путь до доказательства. Бейдж не наследуется: командная победа не доказывает конкретный язык, поэтому такие навыки помечены как вывод."
	testId="skills"
>
	{#if evidence.skillsState === 'none'}
		<InsufficientData hint="Категория ещё не рассчитана: навыки появятся после первого расчёта по фактам профиля." />
	{:else if evidence.skillsState === 'recalculating'}
		<InsufficientData hint="Профиль пересчитывается после изменения оснований: навыки обновятся после расчёта." />
	{:else if evidence.skills.length === 0}
		<InsufficientData hint="Правила пока не вывели из фактов профиля ни одного навыка." />
	{:else}
		<SkillList
			skills={evidence.skills}
			facts={evidence.facts}
			labels={evidence.labels}
			resume={data.resume}
			onField={showResumeField}
		/>
	{/if}
</SectionCard>

<SectionCard
	title="Публичные профили"
	description="Привяжи Codeforces и GitHub: владение подтверждается одноразовым кодом, который ты на время добавляешь в профиль. Затем мы читаем открытые данные и сверяем их раз в сутки. Рейтинг Codeforces подтверждает спортивное программирование и алгоритмы, языки публичных репозиториев GitHub — навыки этих языков, слабее теста платформы; у таких навыков отметка «Публичный профиль». Ссылку на подтверждённый профиль работодатель видит, если ты разрешил это в видимости."
	testId="external-profiles"
>
	<ExternalProfiles profiles={data.externalProfiles} result={profileResult} />
	{#if publicFacts.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2" aria-label="Другие факты публичных профилей">
			{#each publicFacts as fact (fact.id)}
				<li id="fact-{fact.id}" class="scroll-mt-32">
					<FactCard {fact} labels={evidence.labels} />
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>

<SectionCard
	title="Тесты платформы"
	description="Навык, не покрытый результатами ФСП, подтверждается тестом платформы."
>
	{#if testFacts.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2">
			{#each testFacts as fact (fact.id)}
				<li id="fact-{fact.id}" class="scroll-mt-32">
					<FactCard {fact} labels={evidence.labels} />
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-muted-foreground">Пройденных тестов платформы в профиле нет.</p>
	{/if}
</SectionCard>

<SectionCard
	title="Резюме"
	description="Разобранное резюме даёт опыт работы — единственное основание грейда. Навыки из резюме отмечаются как «Заявлено»: у каждого поля есть цитата из файла."
	testId="resume"
>
	{#if data.resume}
		<ResumeSummary bind:this={resumeSummary} resume={data.resume} fact={resumeFact} labels={evidence.labels} />
	{:else}
		{#if resumeFact}
			<div id="fact-{resumeFact.id}" class="scroll-mt-32">
				<FactCard fact={resumeFact} labels={evidence.labels} />
			</div>
		{/if}
		<Empty.Root class="border p-8">
			<Empty.Header>
				<Empty.Media variant="icon"><FileTextIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Опыт работы — из резюме</Empty.Title>
				<Empty.Description>
					Загрузи резюме, и мы найдём в нём места работы, периоды и навыки — у каждого поля будет цитата из файла.
					Проверить и поправить найденное можно там же. Без опыта работы грейд остаётся «недостаточно данных» — это
					честно показано в категории.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<a href={resolve('/me/resume')} class={buttonVariants()}>
					<FileTextIcon aria-hidden="true" />
					Открыть резюме
				</a>
			</Empty.Content>
		</Empty.Root>
	{/if}
	{#if declaredFacts.length > 0}
		<ul class="grid gap-4 lg:grid-cols-2" aria-label="Заявленные факты">
			{#each declaredFacts as fact (fact.id)}
				<li id="fact-{fact.id}" class="scroll-mt-32">
					<FactCard {fact} labels={evidence.labels} />
				</li>
			{/each}
		</ul>
	{/if}
</SectionCard>
