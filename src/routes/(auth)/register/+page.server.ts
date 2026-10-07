import { fail, redirect } from '@sveltejs/kit';
import { authDeps } from '$lib/server/auth/context';
import { currentDocument } from '$lib/server/auth/documents';
import { fspIdConfigured } from '$lib/server/auth/fsp-id';
import { displayNameOf, dropPendingSignup, readPendingSignup } from '$lib/server/auth/fsp-signup';
import { clearSignupCookie, FSP_SIGNUP_COOKIE, requestMeta, sessionOf, setSessionCookie } from '$lib/server/auth/http';
import { formText } from '$lib/server/http/form';
import { register, type Role } from '$lib/server/auth/registration';
import { config } from '$lib/server/config';
import { visitorDemoSessionOf, DEMO_SESSION_REFUSALS } from '$lib/server/demo/visit';
import { objectStore } from '$lib/server/storage/object-store';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	if (sessionOf(event)) redirect(303, '/onboarding');
	const deps = await authDeps();
	const now = deps.now();
	const [userAgreement, employerTerms] = await Promise.all([
		currentDocument(deps.db, 'user_agreement', now),
		currentDocument(deps.db, 'employer_terms', now)
	]);
	const token = event.cookies.get(FSP_SIGNUP_COOKIE);
	const pending = token === undefined ? null : await readPendingSignup(deps.redis, token);
	if (token !== undefined && pending === null) clearSignupCookie(event.cookies);
	const brief = (document: typeof userAgreement) =>
		document && { id: document.id, title: document.title, version: document.version };
	return {
		documents: { userAgreement: brief(userAgreement), employerTerms: brief(employerTerms) },
		fspEnabled: fspIdConfigured(),
		/** A demonstration stand: the account lives in the visitor's demo session and goes with it. */
		demo: config().demo !== null,
		fsp:
			pending === null
				? null
				: {
						displayName: displayNameOf(pending.claims),
						// An address that belongs to another account is not offered again (contracts 2.3, step 3).
						email: pending.emailConflict ? '' : (pending.claims.email ?? ''),
						emailConflict: pending.emailConflict
					}
	};
};

export const actions: Actions = {
	register: async (event) => {
		const form = await event.request.formData();
		const deps = await authDeps();
		const token = event.cookies.get(FSP_SIGNUP_COOKIE);
		const pending = token === undefined ? null : await readPendingSignup(deps.redis, token);
		const role: Role = formText(form, 'role') === 'employer' ? 'employer' : 'candidate';
		const values = {
			role,
			email: formText(form, 'email'),
			displayName: formText(form, 'displayName'),
			birthDate: formText(form, 'birthDate'),
			inn: formText(form, 'inn').replace(/\s/g, ''),
			companyName: formText(form, 'companyName')
		};
		const accepted = (name: string) => (form.get(name) === 'on' ? formText(form, `${name}Id`) : null);
		const userAgreementId = accepted('userAgreement');
		if (userAgreementId === null) {
			return fail(400, { values, errors: { documents: 'Примите пользовательское соглашение' } });
		}
		const password = formText(form, 'password');
		const meta = requestMeta(event);
		const result = await register(deps, meta, {
			email: values.email,
			displayName: values.displayName,
			password: pending !== null && password === '' ? null : password,
			role,
			birthDate: role === 'candidate' ? values.birthDate : null,
			company: role === 'employer' ? { inn: values.inn, name: values.companyName } : null,
			documents: { userAgreementId, employerTermsId: role === 'employer' ? accepted('employerTerms') : null },
			fsp: pending,
			// After FSP ID the account goes where the held result says; a registration by password — into the visitor's session.
			demoSession:
				pending === null && config().demo !== null
					? visitorDemoSessionOf(
							{ ...deps, store: objectStore() },
							{ cookies: event.cookies, address: event.getClientAddress(), meta }
						)
					: null
		});
		if (!result.ok) {
			if ('demoRefused' in result) {
				return fail(result.demoRefused === 'address_budget' ? 429 : 503, {
					values,
					errors: {},
					message: `Регистрация на демо-стенде проходит в вашей демо-сессии, а открыть её не удалось. ${DEMO_SESSION_REFUSALS[result.demoRefused]}`
				});
			}
			return fail(400, { values, errors: result.errors });
		}
		if (token !== undefined) {
			await dropPendingSignup(deps.redis, token);
			clearSignupCookie(event.cookies);
		}
		setSessionCookie(event.cookies, result.sessionId);
		redirect(303, result.letter === 'not_sent' ? '/onboarding?letter=failed' : '/onboarding');
	},

	/** «Войти в существующий аккаунт»: the held FSP ID result is dropped; linking happens from the account. */
	discardFsp: async (event) => {
		const token = event.cookies.get(FSP_SIGNUP_COOKIE);
		if (token !== undefined) {
			await dropPendingSignup((await authDeps()).redis, token);
			clearSignupCookie(event.cookies);
		}
		redirect(303, '/login?returnTo=%2Faccount');
	}
};
