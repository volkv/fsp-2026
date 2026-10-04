// Login and consent page of the simulated FSP ID. There are no passwords: the user picks a synthetic account. The demo
// accounts come first, except the heroes the stand leaves out (`FSP_MOCK_UNLISTED_HEROES`).

import type { IncomingMessage, ServerResponse } from 'node:http';

import type Provider from 'oidc-provider';

import { displayName, type Account, type AccountDirectory } from '../accounts.ts';
import { HttpError, escapeHtml, readForm, sendHtml } from '../http.ts';
import { ACHIEVEMENTS_SCOPE, ACHIEVEMENTS_SERVICE_SCOPE } from './parity.ts';
import { INTERACTION_PATH } from './provider.ts';

const SCOPE_TEXT: Record<string, string> = {
	openid: 'идентификатор учётной записи ФСП ID',
	profile: 'фамилия, имя и имя пользователя',
	email: 'адрес электронной почты',
	offline_access: 'доступ без повторного входа (обновление данных в фоне)',
	[ACHIEVEMENTS_SCOPE]: 'результаты соревнований, разряды и членство в сборной',
	[ACHIEVEMENTS_SERVICE_SCOPE]: 'служебный доступ к достижениям'
};

const KIND_TEXT: Record<Account['kind'], string> = {
	athlete: 'спортсмен',
	no_athlete_profile: 'учётная запись без профиля спортсмена',
	employer: 'представитель работодателя',
	fsp_operator: 'сотрудник ФСП'
};

const SEARCH_LIMIT = 20;

/** Handles `GET|POST {INTERACTION_PATH}/{uid}[/login|/abort]`; returns false for other paths. */
export async function handleInteraction(
	provider: Provider,
	accounts: AccountDirectory,
	unlisted: ReadonlySet<string>,
	req: IncomingMessage,
	res: ServerResponse,
	url: URL
): Promise<boolean> {
	if (!url.pathname.startsWith(`${INTERACTION_PATH}/`)) return false;
	const [uid, action, ...rest] = url.pathname.slice(INTERACTION_PATH.length + 1).split('/');
	if (!uid || rest.length > 0) throw new HttpError(404, 'not_found', 'unknown interaction path');

	const details = await provider.interactionDetails(req, res);
	if (details.uid !== uid) throw new HttpError(400, 'invalid_request', 'interaction does not match the session');

	if (req.method === 'GET' && action === undefined) {
		sendHtml(res, 200, loginPage(details, accounts, unlisted, url.searchParams.get('q') ?? ''));
		return true;
	}

	if (req.method === 'POST' && action === 'abort') {
		await provider.interactionFinished(
			req,
			res,
			{ error: 'access_denied', error_description: 'End-User aborted interaction' },
			{ mergeWithLastSubmission: false }
		);
		return true;
	}

	if (req.method === 'POST' && action === 'login') {
		const form = await readForm(req);
		const sub = form.get('sub') ?? '';
		const account = accounts.get(sub);
		if (!account) throw new HttpError(400, 'invalid_request', 'unknown account');

		const clientId = String(details.params.client_id);
		const requestedScope = typeof details.params.scope === 'string' ? details.params.scope : 'openid';
		// A grant belongs to one account: switching the user starts a new one.
		const existing =
			details.grantId && details.session?.accountId === account.sub
				? await provider.Grant.find(details.grantId)
				: undefined;
		const grant = existing ?? new provider.Grant({ accountId: account.sub, clientId });
		grant.addOIDCScope(requestedScope);
		const missingClaims: unknown = details.prompt.details.missingOIDCClaims;
		if (Array.isArray(missingClaims)) grant.addOIDCClaims(missingClaims.map(String));
		const grantId = await grant.save();

		await provider.interactionFinished(
			req,
			res,
			{
				login: { accountId: account.sub, acr: '1', amr: ['pwd'], remember: false },
				consent: { grantId }
			},
			{ mergeWithLastSubmission: false }
		);
		return true;
	}

	throw new HttpError(405, 'invalid_request', 'method not allowed');
}

type Details = Awaited<ReturnType<Provider['interactionDetails']>>;

function accountButton(account: Account, note: string | null): string {
	return `<li><button type="submit" name="sub" value="${escapeHtml(account.sub)}">
<strong>${escapeHtml(displayName(account))}</strong> <span class="muted">· ${escapeHtml(KIND_TEXT[account.kind])}</span>
${note ? `<br><span class="note">${escapeHtml(note)}</span>` : ''}
<br><code>${escapeHtml(account.sub)}</code></button></li>`;
}

function loginPage(details: Details, accounts: AccountDirectory, unlisted: ReadonlySet<string>, query: string): string {
	const action = `${INTERACTION_PATH}/${details.uid}`;
	const scopes = (typeof details.params.scope === 'string' ? details.params.scope : 'openid').split(' ');
	const reauth = details.prompt.reasons.includes('login_prompt') || details.prompt.reasons.includes('max_age');

	const demo = accounts
		.demo()
		.filter((d) => !unlisted.has(d.sub))
		.map((d) => {
			const account = accounts.get(d.sub);
			return account ? accountButton(account, `${d.title}: ${d.scenario}`) : '';
		})
		.join('');

	const found = query.trim() === '' ? [] : accounts.search(query, SEARCH_LIMIT, unlisted);
	const searchResults =
		query.trim() === ''
			? ''
			: found.length === 0
				? '<p class="muted">Никого не нашлось.</p>'
				: `<form method="post" action="${action}/login"><ul class="accounts">${found.map((a) => accountButton(a, null)).join('')}</ul></form>`;

	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход — имитатор ФСП ID</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1b1f24; }
.banner { background: #fff3cd; border: 1px solid #e0c36a; padding: .75rem 1rem; border-radius: .5rem; }
.muted { color: #5b6470; }
.note { color: #34506b; font-size: .9rem; }
ul.accounts { list-style: none; padding: 0; }
ul.accounts li { margin: .4rem 0; }
ul.accounts button { width: 100%; text-align: left; padding: .6rem .8rem; border: 1px solid #c9d1d9; border-radius: .5rem; background: #fff; cursor: pointer; font: inherit; }
ul.accounts button:hover { border-color: #1f6feb; }
code { font-size: .8rem; color: #5b6470; }
input[type=search] { width: 70%; padding: .4rem; font: inherit; }
</style>
</head>
<body>
<p class="banner"><strong>Имитатор ФСП ID</strong> для тестового стенда. Это не настоящий sso.fsp-russia.ru: учётные записи и
достижения синтетические, пароль не нужен — выберите пользователя.</p>
<h1>Вход в ФСП ID</h1>
${reauth ? '<p><strong>Приложение просит подтвердить вход заново.</strong></p>' : ''}
<p>Приложение <code>${escapeHtml(String(details.params.client_id))}</code> получит:</p>
<ul>${scopes.map((s) => `<li>${escapeHtml(SCOPE_TEXT[s] ?? s)}</li>`).join('')}</ul>
<h2>Демо-учётки</h2>
<form method="post" action="${action}/login"><ul class="accounts">${demo}</ul></form>
<h2>Найти спортсмена</h2>
<form method="get" action="${action}"><input type="search" name="q" value="${escapeHtml(query)}" placeholder="Фамилия, имя или идентификатор"> <button type="submit">Найти</button></form>
${searchResults}
<form method="post" action="${action}/abort"><p><button type="submit">Отказаться от входа</button></p></form>
</body>
</html>`;
}
