// The candidate acting on their own survey and declaration: `candidate.self.write` over their own profile, and the
// profile open — the survey and the declaration are processed under `pd_processing` (domain 6.3, 7.1), which an
// `onboarding` profile has not granted yet.
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { ApiError } from '$lib/server/errors/api-error';

export interface GradeRequestMeta {
	requestId: string;
	ip: string | null;
	userAgent: string | null;
}

export function selfCandidate(subject: AccessSubject): { candidateId: string; userId: string } {
	const candidate = subject.candidate;
	if (!candidate || subject.userId === null) throw new ApiError('forbidden');
	const access = can(subject, 'candidate.self.write', { candidateId: candidate.id });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	if (candidate.status !== 'active') {
		throw new ApiError('forbidden', { message: 'Сначала дайте согласие на обработку профиля' });
	}
	return { candidateId: candidate.id, userId: subject.userId };
}
