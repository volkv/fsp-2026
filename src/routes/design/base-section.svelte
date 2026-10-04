<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SendIcon from '@lucide/svelte/icons/send';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { toast } from 'svelte-sonner';
	import { InvitationStatus, TrustChip } from '$lib/components/product/index.js';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button, buttonVariants } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Checkbox } from '$lib/components/ui/checkbox/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import * as Empty from '$lib/components/ui/empty/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import * as RadioGroup from '$lib/components/ui/radio-group/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import { candidates } from './samples.js';
	import ShowcaseSection from './showcase-section.svelte';
	import Specimen from './specimen.svelte';

	const variants = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const;
	const variantNames: Record<(typeof variants)[number], string> = {
		default: 'Пригласить',
		secondary: 'Сравнить',
		outline: 'Подробнее',
		ghost: 'Скрыть',
		destructive: 'Отозвать',
		link: 'Квитанция'
	};

	const grades = [
		{ value: 'junior', label: 'Младший' },
		{ value: 'middle', label: 'Средний' },
		{ value: 'senior', label: 'Старший' }
	];
	let grade = $state('');
	const gradeLabel = $derived(grades.find((item) => item.value === grade)?.label ?? 'Выберите грейд');

	const declineReasons = [
		{ value: 'salary', label: 'Зарплата' },
		{ value: 'format', label: 'Формат работы' },
		{ value: 'stack', label: 'Стек' },
		{ value: 'not_looking', label: 'Не ищу работу' },
		{ value: 'other', label: 'Другое' }
	];
	let declineReason = $state('salary');
	let onlyVerified = $state(true);
	let notifyTelegram = $state(false);
	let title = $state('');
	const titleInvalid = $derived(title.trim().length > 0 && title.trim().length < 3);

	const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
</script>

<ShowcaseSection
	id="base"
	title="Базовые компоненты"
	description="shadcn-svelte на bits-ui, стилизованные токенами. Работодателю — язык HR: «Пригласить», «Принять / Отклонить с причиной»."
>
	<Specimen title="Кнопки: варианты, размеры, состояния">
		<div class="flex flex-wrap items-center gap-2">
			{#each variants as variant (variant)}
				<Button {variant}>{variantNames[variant]}</Button>
			{/each}
		</div>
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<Button size="sm">Маленькая</Button>
			<Button>Обычная</Button>
			<Button size="lg"><SendIcon aria-hidden="true" />Отправить приглашение</Button>
			<Button disabled>Недоступна</Button>
			<Button disabled><Spinner />Отправляем…</Button>
			<Button size="icon" variant="outline" aria-label="Входящие"><InboxIcon aria-hidden="true" /></Button>
		</div>
	</Specimen>

	<div class="grid gap-4 lg:grid-cols-2">
		<Specimen title="Форма: поля, выбор, ошибки">
			<form
				class="space-y-5"
				onsubmit={(event) => {
					event.preventDefault();
				}}
				novalidate
			>
				<Field.Group>
					<Field.Field data-invalid={titleInvalid || undefined}>
						<Field.Label for="vacancy-title">Название вакансии</Field.Label>
						<Input
							id="vacancy-title"
							bind:value={title}
							placeholder="Например, Go-разработчик"
							aria-invalid={titleInvalid || undefined}
							aria-describedby="vacancy-title-hint"
						/>
						{#if titleInvalid}
							<Field.Error id="vacancy-title-hint">Название — не короче трёх символов.</Field.Error>
						{:else}
							<Field.Description id="vacancy-title-hint">Введите хотя бы 3 символа.</Field.Description>
						{/if}
					</Field.Field>
					<Field.Field>
						<Field.Label for="vacancy-grade">Грейд</Field.Label>
						<Select.Root type="single" bind:value={grade}>
							<Select.Trigger id="vacancy-grade" class="w-56">{gradeLabel}</Select.Trigger>
							<Select.Content>
								{#each grades as item (item.value)}
									<Select.Item value={item.value} label={item.label} />
								{/each}
							</Select.Content>
						</Select.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="vacancy-text">Текст вакансии</Field.Label>
						<Textarea id="vacancy-text" rows={3} placeholder="Вставьте текст — система разложит его на поля" />
					</Field.Field>
					<Field.Field orientation="horizontal">
						<Checkbox id="only-verified" bind:checked={onlyVerified} />
						<Field.Label for="only-verified">Только с навыками, подтверждёнными ФСП</Field.Label>
					</Field.Field>
					<Field.Field orientation="horizontal">
						<Switch id="notify-telegram" bind:checked={notifyTelegram} />
						<Field.Label for="notify-telegram">Уведомления в Telegram</Field.Label>
					</Field.Field>
				</Field.Group>
				<Field.Set>
					<Field.Legend variant="label">Причина отказа</Field.Legend>
					<RadioGroup.Root bind:value={declineReason} class="grid gap-2 sm:grid-cols-2">
						{#each declineReasons as reason (reason.value)}
							<div class="flex items-center gap-2">
								<RadioGroup.Item value={reason.value} id="reason-{reason.value}" />
								<Label for="reason-{reason.value}">{reason.label}</Label>
							</div>
						{/each}
					</RadioGroup.Root>
				</Field.Set>
			</form>
		</Specimen>

		<div class="grid gap-4">
			<Specimen title="Диалоги">
				<div class="flex flex-wrap gap-2">
					<Dialog.Root>
						<Dialog.Trigger class={buttonVariants({ variant: 'outline' })}>Отклонить с причиной</Dialog.Trigger>
						<Dialog.Content>
							<Dialog.Header>
								<Dialog.Title>Отклонить приглашение</Dialog.Title>
								<Dialog.Description>Компания увидит причину, но не ваш комментарий к ней.</Dialog.Description>
							</Dialog.Header>
							<Field.Field>
								<Field.Label for="decline-comment">Комментарий</Field.Label>
								<Textarea id="decline-comment" rows={3} />
							</Field.Field>
							<Dialog.Footer>
								<Dialog.Close class={buttonVariants({ variant: 'outline' })}>Отмена</Dialog.Close>
								<Dialog.Close class={buttonVariants()}>Отклонить</Dialog.Close>
							</Dialog.Footer>
						</Dialog.Content>
					</Dialog.Root>
					<AlertDialog.Root>
						<AlertDialog.Trigger class={buttonVariants({ variant: 'destructive' })}
							>Отозвать приглашение</AlertDialog.Trigger
						>
						<AlertDialog.Content>
							<AlertDialog.Header>
								<AlertDialog.Title>Отозвать приглашение?</AlertDialog.Title>
								<AlertDialog.Description>
									Кандидат увидит, что приглашение отозвано. Повторное предложение — новая версия условий не раньше
									срока, заданного политикой.
								</AlertDialog.Description>
							</AlertDialog.Header>
							<AlertDialog.Footer>
								<AlertDialog.Cancel>Оставить</AlertDialog.Cancel>
								<AlertDialog.Action variant="destructive">Отозвать</AlertDialog.Action>
							</AlertDialog.Footer>
						</AlertDialog.Content>
					</AlertDialog.Root>
				</div>
			</Specimen>

			<Specimen title="Уведомления (тосты) и меню">
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" onclick={() => toast.success('Приглашение отправлено')}>Успех</Button>
					<Button variant="outline" onclick={() => toast.info('Кандидат открыл приглашение')}>Событие</Button>
					<Button variant="outline" onclick={() => toast.error('Не удалось отправить: вакансия закрыта')}>
						Ошибка
					</Button>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger class={buttonVariants({ variant: 'secondary' })}>
							Действия <ChevronDownIcon aria-hidden="true" />
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Label>Кандидат 7F3A</DropdownMenu.Label>
							<DropdownMenu.Item>Пригласить</DropdownMenu.Item>
							<DropdownMenu.Item>Добавить к сравнению</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item variant="destructive">Скрыть из подборки</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</div>
			</Specimen>

			<Specimen title="Бейджи и сообщения">
				<div class="flex flex-wrap items-center gap-2">
					<Badge>Опубликована</Badge>
					<Badge variant="secondary">Черновик</Badge>
					<Badge variant="outline">Внешняя вакансия</Badge>
					<Badge variant="destructive">Заблокирована проверкой текста</Badge>
				</div>
				<Alert.Root variant="destructive" class="mt-3">
					<TriangleAlertIcon aria-hidden="true" />
					<Alert.Title>Вакансия не опубликована</Alert.Title>
					<Alert.Description
						>В тексте найдено требование к полу кандидата — уберите его или отправьте на проверку.</Alert.Description
					>
				</Alert.Root>
			</Specimen>
		</div>
	</div>

	<Specimen title="Таблица: кандидаты под вакансию">
		<Table.Root label="Кандидаты под вакансию">
			<Table.Caption>Псевдонимы — до согласия кандидата имён и контактов нет.</Table.Caption>
			<Table.Header>
				<Table.Row>
					<Table.Head>Кандидат</Table.Head>
					<Table.Head>Роль</Table.Head>
					<Table.Head>Грейд</Table.Head>
					<Table.Head>Подтверждение</Table.Head>
					<Table.Head class="text-right">Соответствие</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each candidates as candidate, index (candidate.pseudonym)}
					<Table.Row>
						<Table.Cell class="font-mono">{candidate.pseudonym}</Table.Cell>
						<Table.Cell>{candidate.role}</Table.Cell>
						<Table.Cell class={candidate.grade === 'не установлен' ? 'text-muted-foreground' : ''}>
							{candidate.grade}
						</Table.Cell>
						<Table.Cell>
							<TrustChip level={index === 1 ? 'claimed' : 'fsp_verified'} signal />
						</Table.Cell>
						<Table.Cell class="text-right font-mono numeric">{percent.format(candidate.match)}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Specimen>

	<div class="grid gap-4 lg:grid-cols-3">
		<Specimen title="Вкладки">
			<Tabs.Root value="invitations">
				<Tabs.List>
					<Tabs.Trigger value="invitations">Приглашения</Tabs.Trigger>
					<Tabs.Trigger value="hiring">Найм</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="invitations" class="pt-3">
					<div class="flex flex-wrap gap-2">
						<InvitationStatus status="sent" />
						<InvitationStatus status="accepted" />
					</div>
				</Tabs.Content>
				<Tabs.Content value="hiring" class="pt-3 text-sm text-muted-foreground"
					>Этапы найма — в разделе ниже.</Tabs.Content
				>
			</Tabs.Root>
		</Specimen>
		<Specimen title="Карточка">
			<Card.Root size="sm">
				<Card.Header>
					<Card.Title>Go-разработчик</Card.Title>
					<Card.Description>Бэкенд · Средний · удалённо</Card.Description>
				</Card.Header>
				<Card.Content class="text-sm">Обязательные: Go, PostgreSQL. Желательные: Kafka.</Card.Content>
				<Card.Footer class="gap-2">
					<Button size="sm">Кандидаты</Button>
					<Button size="sm" variant="ghost">Изменить</Button>
				</Card.Footer>
			</Card.Root>
		</Specimen>
		<Specimen title="Загрузка (скелетон)">
			<div class="space-y-3" role="status" aria-busy="true" aria-label="Загрузка карточки">
				<Skeleton class="h-5 w-2/3" />
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-5/6" />
				<Separator />
				<div class="flex gap-2">
					<Skeleton class="h-6 w-20 rounded-full" />
					<Skeleton class="h-6 w-24 rounded-full" />
				</div>
			</div>
		</Specimen>
	</div>

	<Specimen title="Пустое состояние">
		<Empty.Root class="border border-dashed">
			<Empty.Header>
				<Empty.Media variant="icon"><InboxIcon aria-hidden="true" /></Empty.Media>
				<Empty.Title>Приглашений пока нет</Empty.Title>
				<Empty.Description>
					Работодатели находят кандидатов по подтверждённым навыкам. Подтвердите навык тестом — так вас проще найти.
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	</Specimen>
</ShowcaseSection>
