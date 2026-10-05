import type { Component } from 'svelte';
import { resolve } from '$app/paths';
import type { ResolvedPathname } from '$app/types';
import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
import BookOpenCheckIcon from '@lucide/svelte/icons/book-open-check';
import BriefcaseIcon from '@lucide/svelte/icons/briefcase';
import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
import ClipboardCheckIcon from '@lucide/svelte/icons/clipboard-check';
import DownloadIcon from '@lucide/svelte/icons/download';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import FileUpIcon from '@lucide/svelte/icons/file-up';
import FileUserIcon from '@lucide/svelte/icons/file-user';
import GaugeIcon from '@lucide/svelte/icons/gauge';
import GlobeIcon from '@lucide/svelte/icons/globe';
import GitCompareArrowsIcon from '@lucide/svelte/icons/git-compare-arrows';
import HandshakeIcon from '@lucide/svelte/icons/handshake';
import InboxIcon from '@lucide/svelte/icons/inbox';
import LayersIcon from '@lucide/svelte/icons/layers';
import ListChecksIcon from '@lucide/svelte/icons/list-checks';
import MessageSquareWarningIcon from '@lucide/svelte/icons/message-square-warning';
import ScaleIcon from '@lucide/svelte/icons/scale';
import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
import ScanTextIcon from '@lucide/svelte/icons/scan-text';
import RssIcon from '@lucide/svelte/icons/rss';
import SearchIcon from '@lucide/svelte/icons/search';
import SendIcon from '@lucide/svelte/icons/send';
import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
import SwordsIcon from '@lucide/svelte/icons/swords';
import TagIcon from '@lucide/svelte/icons/tag';
import TargetIcon from '@lucide/svelte/icons/target';
import Trash2Icon from '@lucide/svelte/icons/trash-2';
import TrophyIcon from '@lucide/svelte/icons/trophy';
import UserRoundIcon from '@lucide/svelte/icons/user-round';
import UsersIcon from '@lucide/svelte/icons/users';

/** Workspaces of the product: one per role (domain §4.1); owner and recruiter share the employer workspace. */
export type Workspace = 'candidate' | 'employer' | 'operator' | 'admin';

/**
 * Permissions that decide which sections the shell shows beyond the workspace of a role. The server computes them for
 * the viewer with the same check as the pages behind the sections; a section is a link, not the access control.
 */
export const NAV_PERMISSIONS = ['audit.read', 'partner_pool.read'] as const;

export type NavPermission = (typeof NAV_PERMISSIONS)[number];

export interface NavItem {
	label: string;
	icon: Component;
	/** Page of the section, already passed through `resolve()`. */
	href: ResolvedPathname;
	/** Shown only to a viewer holding this permission; without it the section is part of the workspace. */
	permission?: NavPermission;
}

export interface WorkspaceNav {
	label: string;
	items: NavItem[];
}

/**
 * Sections of each workspace, the most used first: every item leads to a built page. The navigation carries no data
 * of its own. Labels are short: every row, with the sections behind a permission, fits a 1280 px screen without
 * scrolling; the workspace name gives the context («Оператор ФСП» → «Импорт»), and the tabs of a cabinet carry the
 * full titles.
 */
export const WORKSPACES: Record<Workspace, WorkspaceNav> = {
	candidate: {
		label: 'Кандидат',
		items: [
			{ label: 'Профиль', icon: UserRoundIcon, href: resolve('/me/profile') },
			{ label: 'Категория', icon: TagIcon, href: resolve('/me/category') },
			{ label: 'Резюме', icon: FileUserIcon, href: resolve('/me/resume') },
			{ label: 'Вакансии', icon: BriefcaseIcon, href: resolve('/me/vacancies') },
			{ label: 'Приглашения', icon: InboxIcon, href: resolve('/me/invitations') },
			{ label: 'Вызовы', icon: SwordsIcon, href: resolve('/me/challenges') },
			{ label: 'Тесты', icon: ClipboardCheckIcon, href: resolve('/me/tests') },
			{ label: 'Мои данные', icon: DownloadIcon, href: resolve('/me/export') },
			{ label: 'Удалить учётную запись', icon: Trash2Icon, href: resolve('/account/delete') }
		]
	},
	employer: {
		label: 'Работодатель',
		items: [
			{ label: 'Потребности', icon: TargetIcon, href: resolve('/company/needs') },
			{ label: 'Кандидаты', icon: SearchIcon, href: resolve('/company/candidates') },
			{ label: 'Вакансии', icon: BriefcaseIcon, href: resolve('/company/vacancies') },
			{ label: 'Внешние вакансии', icon: GlobeIcon, href: resolve('/company/vacancies/external') },
			{ label: 'Приглашения', icon: InboxIcon, href: resolve('/company/invitations') },
			{ label: 'Отклики', icon: SendIcon, href: resolve('/company/applications') },
			{ label: 'Вызовы', icon: SwordsIcon, href: resolve('/company/challenges') },
			{ label: 'Найм', icon: ListChecksIcon, href: resolve('/company/hiring') },
			{
				label: 'Пул партнёра',
				icon: HandshakeIcon,
				href: resolve('/company/partner-pools'),
				permission: 'partner_pool.read'
			},
			{ label: 'Компания', icon: UsersIcon, href: resolve('/company/profile') }
		]
	},
	operator: {
		label: 'Оператор ФСП',
		items: [
			{ label: 'Компании', icon: ShieldCheckIcon, href: resolve('/operator/companies') },
			{ label: 'Возражения', icon: MessageSquareWarningIcon, href: resolve('/operator/objections') },
			{ label: 'Заявки', icon: BadgeCheckIcon, href: resolve('/operator/claims') },
			{ label: 'Представители', icon: BookOpenCheckIcon, href: resolve('/operator/representatives') },
			{ label: 'Вакансии', icon: ScanTextIcon, href: resolve('/operator/vacancies') },
			{ label: 'Исходы', icon: ChartColumnIcon, href: resolve('/operator/outcomes') },
			{ label: 'Партнёрства', icon: HandshakeIcon, href: resolve('/operator/partnerships') },
			{ label: 'Навыки', icon: GitCompareArrowsIcon, href: resolve('/operator/skills') },
			{ label: 'Импорт', icon: FileUpIcon, href: resolve('/operator/fsp-import') },
			{ label: 'Журнал', icon: ScrollTextIcon, href: resolve('/operator/audit'), permission: 'audit.read' }
		]
	},
	admin: {
		label: 'Администратор',
		items: [
			{ label: 'Справочники', icon: LayersIcon, href: resolve('/admin/taxonomy') },
			{ label: 'Правила', icon: SlidersHorizontalIcon, href: resolve('/admin/rules') },
			{ label: 'Источники вакансий', icon: RssIcon, href: resolve('/admin/sources') },
			{ label: 'Качество моделей', icon: GaugeIcon, href: resolve('/admin/quality') },
			{ label: 'Политики', icon: ScaleIcon, href: resolve('/admin/policies') },
			{ label: 'Задания', icon: ClipboardCheckIcon, href: resolve('/admin/bank') },
			{ label: 'Журнал', icon: ScrollTextIcon, href: resolve('/admin/audit') },
			{ label: 'Документы', icon: FileTextIcon, href: resolve('/admin/documents') },
			{ label: 'Персонал', icon: UsersIcon, href: resolve('/admin/staff') }
		]
	}
};

/** Links of the public header (no session). */
export const PUBLIC_NAV: NavItem[] = [
	{ label: 'Работодателям', icon: BriefcaseIcon, href: resolve('/#employers') },
	{ label: 'Кандидатам', icon: UserRoundIcon, href: resolve('/#candidates') },
	{ label: 'Федерации', icon: TrophyIcon, href: resolve('/#fsp') }
];

// Routes of the sign-in module. Literal types: `resolve()` checks each one against the routes of the application.

/** Start of the sign-in through FSP ID (contracts §2.1): the route redirects to the provider. */
export const SIGN_IN_HREF = '/auth/fsp';

/** Sign-in by password, with the FSP ID button and links to registration and recovery. */
export const LOGIN_HREF = '/login';

export const REGISTER_HREF = '/register';

/** Remaining registration steps: address, consent, representative, company. */
export const ONBOARDING_HREF = '/onboarding';

/** Account and security: sign-in methods, password, sessions. */
export const ACCOUNT_HREF = '/account';

/** Where a signed-in person starts: the registration steps until they are done, then the account. */
export function homeHref(onboardingComplete: boolean): ResolvedPathname {
	return onboardingComplete ? resolve(ACCOUNT_HREF) : resolve(ONBOARDING_HREF);
}

/** Items the viewer may open: those without a permission and those whose permission the viewer holds. */
export function permittedItems<T extends { permission?: NavPermission }>(
	items: readonly T[],
	permissions: readonly NavPermission[]
): T[] {
	return items.filter((item) => item.permission === undefined || permissions.includes(item.permission));
}

const inside = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

const SECTION_HREFS: readonly string[] = Object.values(WORKSPACES).flatMap((workspace) =>
	workspace.items.map((item) => item.href)
);

/**
 * Whether `pathname` is inside the section (its page or any page under it) and not inside a nested section of its own
 * («Внешние вакансии» under «Вакансии»); fragment links are never active.
 */
export function isActive(pathname: string, item: NavItem): boolean {
	if (item.href.includes('#') || !inside(pathname, item.href)) return false;
	return !SECTION_HREFS.some(
		(href) => href.length > item.href.length && inside(href, item.href) && inside(pathname, href)
	);
}
