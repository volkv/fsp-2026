<script lang="ts">
	import BrandStrip from '$lib/components/brand/brand-strip.svelte';
	import FspLogo from '$lib/components/brand/fsp-logo.svelte';
	import FspSign from '$lib/components/brand/fsp-sign.svelte';
	import ShowcaseSection from './showcase-section.svelte';
	import Specimen from './specimen.svelte';

	// Full class names: Tailwind generates only classes it finds literally in the source.
	const brand = [
		{ step: '50', swatch: 'bg-brand-50' },
		{ step: '100', swatch: 'bg-brand-100' },
		{ step: '200', swatch: 'bg-brand-200' },
		{ step: '300', swatch: 'bg-brand-300' },
		{ step: '400', swatch: 'bg-brand-400' },
		{ step: '500', swatch: 'bg-brand-500' },
		{ step: '600', swatch: 'bg-brand-600' },
		{ step: '700', swatch: 'bg-brand-700' },
		{ step: '800', swatch: 'bg-brand-800' },
		{ step: '900', swatch: 'bg-brand-900' },
		{ step: '950', swatch: 'bg-brand-950' }
	];
	const ink = [
		{ step: '0', swatch: 'bg-ink-0' },
		{ step: '25', swatch: 'bg-ink-25' },
		{ step: '75', swatch: 'bg-ink-75' },
		{ step: '150', swatch: 'bg-ink-150' },
		{ step: '300', swatch: 'bg-ink-300' },
		{ step: '400', swatch: 'bg-ink-400' },
		{ step: '500', swatch: 'bg-ink-500' },
		{ step: '700', swatch: 'bg-ink-700' },
		{ step: '800', swatch: 'bg-ink-800' },
		{ step: '850', swatch: 'bg-ink-850' },
		{ step: '875', swatch: 'bg-ink-875' },
		{ step: '900', swatch: 'bg-ink-900' }
	];

	const disciplines = [
		{ name: 'Продуктовое', hex: '#8F1BF4', swatch: 'bg-discipline-product text-discipline-product-foreground' },
		{
			name: 'Алгоритмическое',
			hex: '#402FFD',
			swatch: 'bg-discipline-algorithmic text-discipline-algorithmic-foreground'
		},
		{ name: 'БАС', hex: '#1ED3CA', swatch: 'bg-discipline-uas text-discipline-uas-foreground' },
		{ name: 'Робототехника', hex: '#ECB617', swatch: 'bg-discipline-robotics text-discipline-robotics-foreground' },
		{ name: 'ИБ', hex: '#09A953', swatch: 'bg-discipline-infosec text-discipline-infosec-foreground' }
	];

	const roles = [
		{ name: 'background', swatch: 'bg-background', note: 'страница' },
		{ name: 'card', swatch: 'bg-card', note: 'карточки, поля' },
		{ name: 'muted', swatch: 'bg-muted', note: 'приглушённые поверхности' },
		{ name: 'primary', swatch: 'bg-primary', note: 'акцент ФСП #402FFF' },
		{ name: 'accent', swatch: 'bg-accent', note: 'выделение, активный пункт' },
		{ name: 'link', swatch: 'bg-link', note: 'текст ссылок' },
		{ name: 'border', swatch: 'bg-border', note: 'разделители' },
		{ name: 'input', swatch: 'bg-input', note: 'граница полей, ≥ 3:1' },
		{ name: 'success', swatch: 'bg-success', note: 'успех' },
		{ name: 'warning', swatch: 'bg-warning', note: 'предупреждение' },
		{ name: 'destructive', swatch: 'bg-destructive', note: 'ошибка' },
		{ name: 'brand-red', swatch: 'bg-brand-red', note: 'только логотип и метки' }
	];

	const trust = [
		{ name: 'trust-fsp', swatch: 'bg-trust-fsp' },
		{ name: 'trust-platform', swatch: 'bg-trust-platform border-trust-platform-border' },
		{ name: 'trust-public', swatch: 'bg-trust-public border-trust-public-border' },
		{ name: 'trust-claimed', swatch: 'border-dashed border-trust-claimed-border' }
	];

	const type = [
		{ token: 'text-display', sample: 'ФСП | Карьера', font: 'font-heading' },
		{ token: 'text-h1', sample: 'Кандидаты под вакансию', font: 'font-heading' },
		{ token: 'text-h2', sample: 'Почему подходит', font: 'font-heading' },
		{ token: 'text-h3', sample: 'Квитанция проверки', font: 'font-heading' },
		{ token: 'text-figure', sample: '228', font: 'accent-figure' },
		{ token: 'text-metric', sample: '200 000 ₽', font: 'font-heading numeric' },
		{ token: 'text-lg', sample: 'Работодатель напишет первым — сразу с зарплатой.', font: 'font-sans' },
		{ token: 'text-base', sample: 'Профиль собирается сам: достижения, резюме, публичные профили.', font: 'font-sans' },
		{ token: 'text-sm', sample: 'Что подтверждено и чего это не доказывает.', font: 'font-sans' },
		{ token: 'text-label', sample: 'АЛГОРИТМИЧЕСКОЕ · 2026', font: 'font-mono' }
	];

	const radii = [
		{ token: 'rounded-sm', px: '4' },
		{ token: 'rounded-md', px: '6 — контролы' },
		{ token: 'rounded-lg', px: '8' },
		{ token: 'rounded-xl', px: '12 — карточки' },
		{ token: 'rounded-2xl', px: '20 — панели' },
		{ token: 'rounded-full', px: 'чипы' }
	];

	const shadows = ['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg'];
</script>

<ShowcaseSection
	id="tokens"
	title="Токены"
	description="Все значения — в src/app.css: примитивы бренда ФСП по брендбуку 2026, семантические роли светлой и тёмной темы, привязки к Tailwind. Замена палитры под макеты — правка двух блоков ролей."
>
	<div class="grid gap-4 lg:grid-cols-2">
		<Specimen title="Синий ФСП (brand), 500 = #402FFF">
			<ul class="grid grid-cols-6 gap-2 sm:grid-cols-11">
				{#each brand as item (item.step)}
					<li class="space-y-1 text-center">
						<span class="block h-10 rounded-md border {item.swatch}"></span>
						<span class="font-mono text-xs text-muted-foreground">{item.step}</span>
					</li>
				{/each}
			</ul>
		</Specimen>
		<Specimen title="Нейтральные (ink) — сайт и кабинет ФСП">
			<ul class="grid grid-cols-6 gap-2 sm:grid-cols-11">
				{#each ink as item (item.step)}
					<li class="space-y-1 text-center">
						<span class="block h-10 rounded-md border {item.swatch}"></span>
						<span class="font-mono text-xs text-muted-foreground">{item.step}</span>
					</li>
				{/each}
			</ul>
		</Specimen>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<Specimen title="Логотип ФСП: светлая и тёмная поверхность">
			<div class="grid gap-3 sm:grid-cols-2">
				<div class="flex items-center gap-3 rounded-lg border bg-background p-4">
					<FspLogo class="h-8" />
					<FspSign class="size-8" />
				</div>
				<div class="dark flex items-center gap-3 rounded-lg border bg-background p-4 text-foreground">
					<FspLogo class="h-8" />
					<FspSign class="size-8" />
				</div>
			</div>
		</Specimen>
		<Specimen title="Цвет дисциплин ФСП — только заливка, иконка по контрасту">
			<ul class="grid grid-cols-3 gap-3 sm:grid-cols-5">
				{#each disciplines as item (item.name)}
					<li class="space-y-1">
						<span class="flex h-10 items-center justify-center rounded-md font-mono text-xs {item.swatch}">
							{item.hex}
						</span>
						<span class="block text-xs text-muted-foreground">{item.name}</span>
					</li>
				{/each}
			</ul>
		</Specimen>
	</div>

	<Specimen title="Лента паттерна ФСП: полосой во всю ширину (главная, подвал) и фрагментом (пустые состояния)">
		<div class="space-y-4">
			<BrandStrip class="h-6" />
			<div class="dark rounded-lg bg-background p-4">
				<BrandStrip class="h-5" />
			</div>
			<div class="flex flex-wrap items-center gap-6">
				<BrandStrip tiles={1} class="h-4" />
				<BrandStrip tiles={2} class="h-4" />
			</div>
		</div>
	</Specimen>

	<Specimen title="Семантические роли (меняются с темой)">
		<ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
			{#each roles as role (role.name)}
				<li class="flex items-center gap-3">
					<span class="size-10 shrink-0 rounded-md border {role.swatch}"></span>
					<span class="text-sm">
						<span class="block font-mono">{role.name}</span>
						<span class="text-muted-foreground">{role.note}</span>
					</span>
				</li>
			{/each}
			{#each trust as item (item.name)}
				<li class="flex items-center gap-3">
					<span class="size-10 shrink-0 rounded-full border {item.swatch}"></span>
					<span class="font-mono text-sm">{item.name}</span>
				</li>
			{/each}
		</ul>
	</Specimen>

	<Specimen
		title="Типографика: JetBrains Mono — заголовки, числа, метки; Inter — текст; TDAText — только крупные числа от 24 px"
	>
		<ul class="space-y-3">
			{#each type as item (item.token)}
				<li class="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-baseline">
					<span class="font-mono text-xs text-muted-foreground">{item.token}</span>
					<span class="{item.token} {item.font} truncate">{item.sample}</span>
				</li>
			{/each}
		</ul>
	</Specimen>

	<div class="grid gap-4 lg:grid-cols-2">
		<Specimen title="Радиусы">
			<ul class="flex flex-wrap gap-4">
				{#each radii as radius (radius.token)}
					<li class="space-y-1 text-center">
						<span class="block size-16 border-2 border-primary bg-accent {radius.token}"></span>
						<span class="block font-mono text-xs text-muted-foreground">{radius.px}</span>
					</li>
				{/each}
			</ul>
		</Specimen>
		<Specimen title="Тени (в тёмной теме — плоско, ступень поверхности)">
			<ul class="flex flex-wrap gap-4 p-2">
				{#each shadows as shadow (shadow)}
					<li class="flex size-20 items-center justify-center rounded-xl border bg-card {shadow}">
						<span class="font-mono text-xs text-muted-foreground">{shadow}</span>
					</li>
				{/each}
			</ul>
		</Specimen>
	</div>
</ShowcaseSection>
