import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { authDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { fspIdentityOf, unlinkFspIdentity } from '$lib/server/auth/identities';
import { clearSessionCookie, requestMeta, requireSession, setSessionCookie } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { onboardingState } from '$lib/server/auth/onboarding';
import { changePassword } from '$lib/server/auth/recovery';
import { countUserSessions, isFreshAuth } from '$lib/server/auth/sessions';
import { signOutEverywhere } from '$lib/server/auth/signout';
import { config } from '$lib/server/config';
import { passwordCredentials, users } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

/** The FSP ID notices the callback and the actions pass as `?fsp=`. */
const FSP_NOTICES: Record<string, { tone: 'success' | 'error'; text: string }> = {
	linked: { tone: 'success', text: 'ФСП ID привязан: теперь можно входить через него.' },
	unlinked: { tone: 'success', text: 'ФСП ID отвязан. Импортированные достижения выведены из профиля.' },
	imported: {
		tone: 'success',
		text: 'Согласие дано: достижения из ФСП подтянутся в профиль в течение нескольких минут.'
	},
	identity_already_linked: {
		tone: 'error',
		text: 'Этот ФСП ID уже привязан к другой учётной записи. Отвязать его можно только из неё.'
	},
	issuer_already_linked: { tone: 'error', text: 'К учётной записи уже привязан ФСП ID: сначала отвяжите его.' },
	session_mismatch: { tone: 'error', text: 'Привязка начата из другого сеанса. Начните её заново.' },
	failed: { tone: 'error', text: 'Не удалось привязать ФСП ID. Начните заново.' }
};

export const load: PageServerLoad = async (event) => {
	const session = requireSession(event);
	const deps = await authDeps();
	const now = deps.now();
	const [user] = await deps.db
		.select({
			emailEnc: users.emailEnc,
			verifiedAt: users.emailVerifiedAt,
			displayName: users.displayName,
			hasPassword: passwordCredentials.userId
		})
		.from(users)
		.leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
		.where(eq(users.id, session.userId));
	if (!user?.emailEnc) throw new Error(`session user ${session.userId} has no account`);
	const fspIssuer = config().fspId?.issuer ?? null;
	const identity = fspIssuer === null ? null : await fspIdentityOf(deps, session.userId, fspIssuer);
	const onboarding = await onboardingState(deps, session.userId);
	const importDocument = await currentDocument(deps.db, 'fsp_import', now);
	const notice = FSP_NOTICES[event.url.searchParams.get('fsp') ?? ''] ?? null;
	return {
		account: {
			email: deps.crypto.decrypt(user.emailEnc, 'users.email'),
			emailVerified: user.verifiedAt !== null,
			hasPassword: user.hasPassword !== null
		},
		fsp:
			fspIssuer === null
				? null
				: {
						identity: identity && {
							subject: identity.subject,
							linkedAt: identity.linkedAt.toISOString(),
							athleteLinked: identity.athleteLink !== null
						},
						canImport:
							identity !== null &&
							identity.athleteLink === null &&
							onboarding.candidate?.status === 'active' &&
							importDocument?.available === true
					},
		freshAuth: isFreshAuth(session.authTime, now),
		sessions: await countUserSessions(deps.redis, session.userId),
		notice
	};
};

export const actions: Actions = {
	unlink: async (event) => {
		const session = requireSession(event);
		const issuer = config().fspId?.issuer;
		if (!issuer) return fail(404, { unlinkMessage: 'Вход через ФСП ID не настроен' });
		const result = await unlinkFspIdentity(await authDeps(), requestMeta(event), session, issuer);
		if (!result.ok) {
			if (result.reason === 'stale_auth') redirect(303, '/account/reauth?returnTo=%2Faccount');
			return fail(409, {
				unlinkMessage:
					result.reason === 'last_sign_in_method'
						? 'Сначала задайте пароль: без него и без ФСП ID войти будет нечем'
						: 'ФСП ID не привязан'
			});
		}
		redirect(303, '/account?fsp=unlinked');
	},

	password: async (event) => {
		const session = requireSession(event);
		const form = await event.request.formData();
		if (formText(form, 'next') !== formText(form, 'repeat'))
			return fail(400, { passwordMessage: 'Новые пароли не совпадают' });
		const current = form.has('current') ? formText(form, 'current') : null;
		const result = await changePassword(await authDeps(), requestMeta(event), session, {
			current,
			next: formText(form, 'next')
		});
		if (!result.ok) {
			if (result.reason === 'stale_auth') redirect(303, '/account/reauth?returnTo=%2Faccount');
			return fail(400, {
				passwordMessage: result.reason === 'weak' ? result.problems.join('. ') : 'Текущий пароль неверен'
			});
		}
		setSessionCookie(event.cookies, result.sessionId);
		return { passwordChanged: true };
	},

	signOutAll: async (event) => {
		const session = requireSession(event);
		await signOutEverywhere(await authDeps(), requestMeta(event), session);
		clearSessionCookie(event.cookies);
		redirect(303, '/login');
	}
};
