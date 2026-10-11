<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
	import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LinkIcon from '@lucide/svelte/icons/link';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import TrophyIcon from '@lucide/svelte/icons/trophy';
	import { resolve } from '$app/paths';
	import ExternalProfiles from '$lib/components/candidate/external-profiles.svelte';
	import ManualExperience from '$lib/components/candidate/manual-experience.svelte';
	import ProfileFields from '$lib/components/candidate/profile-fields.svelte';
	import ProfilePdf from '$lib/components/candidate/profile-pdf.svelte';
	import FactCard from '$lib/components/candidate/fact-card.svelte';
	import type { FactSource, FactView } from '$lib/components/candidate/model.js';
	import SearchStatus from '$lib/components/candidate/search-status.svelte';
	import SettingsSection from '$lib/components/candidate/settings-section.svelte';
	import SkillList from '$lib/components/candidate/skill-list.svelte';
	import PageHeader from '$lib/components/forms/page-header.svelte';
	import { InsufficientData } from '$lib/components/product/index.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const evidence = $derived(data.evidence);

	/**
	 * Every fact of the profile has its place on the page, by its source: a skill names the facts it rests on and opens
	 * them by their anchors, so no fact may be left without one. The resume has a page of its own: a skill resting on it
	 * leads there.
	 */
	const SECTIONS: Record<FactSource, 'fsp' | 'tests' | 'public' | 'resume'> = {
		fsp: 'fsp',
		platform_test: 'tests',
		codeforces: 'public',
		github: 'public',
		resume: 'resume'
	};
	const factsOf = (section: (typeof SECTIONS)[FactSource]): FactView[] =>
		evidence.facts.filter((fact) => SECTIONS[fact.source] === section);
	const fspFacts = $derived(factsOf('fsp'));
	const testFacts = $derived(factsOf('tests'));
	// A public profile shows its current fact in its own card, with the state of ownership and of the last reading;
	// a fact of a public profile without such a card is shown on its own.
	const profileFactIds = $derived(new Set(data.externalProfiles.map((profile) => profile.factId)));
	const publicFacts = $derived(factsOf('public').filter((fact) => !profileFactIds.has(fact.id)));
	const profileResult = $derived(form && 'target' in form ? form : null);
	const own = $derived(data.own);
	/** The answer of an action on the own fields, the suggestions or the experience stated by hand. */
	const ownResult = $derived(
		form &&
			'target' in form &&
			typeof form.target === 'string' &&
			!form.target.startsWith('profile:') &&
			form.target !== 'link'
			? form
			: null
	);

	const CONSENT_STATES = {
		effective: 'Действует',
		representative_received: 'Действует: согласие представителя получено',
		representative_pending: 'Согласие представителя ожидается',
		representative_missing: 'Нужен законный представитель',
		own_missing: 'Нужна ваша подпись: после 18 лет согласие подтверждается заново'
	} as const;
</script>

<PageHeader
	title="Ваш профиль"
	description="Ваши победы засчитываются в карьере: профиль собирается сам из проверяемых фактов. Здесь видно, что подтверждено, откуда это взялось и чего не хватает."
	class="items-start"
>
	{#snippet eyebrow()}{evidence.displayName}{/snippet}
	{#snippet actions()}
		<!-- In line with the title, below the line of the name above it. -->
		<div class="flex flex-wrap gap-2 sm:pt-6.5">
			<a href={resolve('/me/resume')} class={buttonVariants({ variant: 'outline' })}>
				<FileUpIcon aria-hidden="true" />
				Загрузить резюме
			</a>
			<ProfilePdf
				hasName={own.profile.fullName !== null}
				hasPhone={own.profile.phone !== null}
				hasTelegram={own.profile.telegram !== null}
			/>
		</div>
	{/snippet}
</PageHeader>

<div class="grid">
	<SettingsSection
		title="Статус"
		panel
		icon={ActivityIcon}
		description="Готовность получать предложения. «Активно ищу» и «Открыт к предложениям» показывают профиль проверенным компаниям — они сами выходят на вас с вакансией и зарплатой."
		class="border-t-0 pt-0"
	>
		<SearchStatus status={evidence.searchStatus} catalog={data.catalog} />
		<dl class="grid border-t" aria-label="Статус профиля">
			<div class="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0 last:pb-0">
				<div class="grid gap-0.5">
					<dt class="text-xs text-muted-foreground">Кто видит профиль</dt>
					<dd class="text-sm font-medium">Что видят компании, согласие на показ</dd>
				</div>
				<a href={resolve('/me/visibility')} class={buttonVariants({ variant: 'outline', size: 'sm' })}>Видимость</a>
			</div>
			<div
				class="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0 last:pb-0"
				data-testid="consent-state"
				data-state={data.consent}
			>
				<div class="grid gap-0.5">
					<dt class="text-xs text-muted-foreground">Согласие на обработку данных</dt>
					<dd class="text-sm font-medium">{CONSENT_STATES[data.consent]}</dd>
				</div>
				<a href={resolve('/me/consents')} class={buttonVariants({ variant: 'outline', size: 'sm' })}>Согласия</a>
			</div>
		</dl>
	</SettingsSection>

	<ProfileFields
		profile={own.profile}
		suggestions={own.suggestions}
		softSkills={data.softSkills}
		maxSoftSkills={data.maxSoftSkills}
		result={ownResult}
		onshow={null}
	/>

	<SettingsSection
		title="Навыки"
		icon={SparklesIcon}
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
			<SkillList skills={evidence.skills} facts={evidence.facts} labels={evidence.labels} resume={data.resume} />
		{/if}
	</SettingsSection>

	<SettingsSection
		title="Достижения ФСП"
		icon={TrophyIcon}
		description="ФСП подтверждает факт: соревнование, результат, роль. Что именно факт подтверждает, а чего нет — в квитанции проверки."
		testId="fsp-achievements"
	>
		{#if fspFacts.length > 0}
			<ul class="grid gap-4">
				{#each fspFacts as fact (fact.id)}
					<li id="fact-{fact.id}" class="scroll-mt-32">
						<FactCard {fact} labels={evidence.labels} layout="row" />
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
							Привяжите ФСП ID, затем дайте отдельное согласие на импорт — результаты, разряды и членство в сборной
							подтянутся сами, с квитанциями проверки.
						{:else if data.fspStep === 'import'}
							ФСП ID привязан. Дайте отдельное согласие на импорт — результаты соревнований подтянутся сами.
						{:else if data.fspStep === 'unavailable'}
							Вход через ФСП ID на этой установке не настроен: импорт достижений недоступен.
						{:else}
							Импорт по вашему согласию включён. Если результаты ещё загружаются или в ФСП их нет, список пуст.
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
	</SettingsSection>

	<SettingsSection
		title="Публичные профили"
		icon={GlobeIcon}
		description="Привяжите Codeforces и GitHub: владение подтверждается одноразовым кодом, который вы на время добавляете в профиль. Затем мы читаем открытые данные и сверяем их раз в сутки. Рейтинг Codeforces подтверждает спортивное программирование и алгоритмы, языки публичных репозиториев GitHub — навыки этих языков, слабее теста платформы; у таких навыков отметка «Публичный профиль». Ссылку на подтверждённый профиль работодатель видит, если вы разрешили это в видимости."
		testId="external-profiles"
	>
		<ExternalProfiles profiles={data.externalProfiles} result={profileResult} />
		{#if publicFacts.length > 0}
			<ul class="grid gap-4 xl:grid-cols-2" aria-label="Другие факты публичных профилей">
				{#each publicFacts as fact (fact.id)}
					<li id="fact-{fact.id}" class="scroll-mt-32">
						<FactCard {fact} labels={evidence.labels} />
					</li>
				{/each}
			</ul>
		{/if}
	</SettingsSection>

	<SettingsSection
		title="Тесты платформы"
		panel
		icon={ClipboardCheckIcon}
		description="Навык, не покрытый результатами ФСП, подтверждается тестом платформы."
	>
		{#if testFacts.length > 0}
			<ul class="grid gap-4 xl:grid-cols-2">
				{#each testFacts as fact (fact.id)}
					<li id="fact-{fact.id}" class="scroll-mt-32">
						<FactCard {fact} labels={evidence.labels} />
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-muted-foreground">Пройденных тестов платформы в профиле нет.</p>
		{/if}
	</SettingsSection>

	<SettingsSection
		title="Опыт работы"
		panel
		icon={BriefcaseIcon}
		description="Места работы с ваших слов — например, те, что не вошли в резюме. Попадают в PDF-профиль с пометкой «указано кандидатом»; подсказка грейда, категория и подбор опираются на резюме и тесты."
		testId="manual-experience-section"
	>
		<ManualExperience
			entries={own.experience}
			months={own.experienceMonthsText}
			skills={data.skills}
			roles={data.roles}
			result={ownResult}
		/>
	</SettingsSection>
</div>
