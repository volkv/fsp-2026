import { authDeps } from '$lib/server/auth/context';
import { loadViewer } from '$lib/server/auth/viewer';
import type { LayoutServerLoad } from './$types';

/** The signed-in person on every page: the header shows the name, the workspace and the sign-out form. */
export const load: LayoutServerLoad = async ({ locals }) => {
	const { actor } = locals;
	if (actor.kind !== 'session') return { viewer: null };
	const { viewer } = await loadViewer(await authDeps(), actor);
	return { viewer };
};
