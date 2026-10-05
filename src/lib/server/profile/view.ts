// The candidate's own profile as the cabinet and `GET /api/v1/me/profile` show it (docs/domain.md, section 7.1): the
// fields, the experience stated by hand with its length, the suggestions of the current resume with their quotes, and
// the confirmations of the categories with their status now and the holder code.
import type { AccessSubject } from '$lib/server/access/permissions';
import { ownAttestations } from '$lib/server/attestations/issue';
import { verifyAttestation, type AttestationStatus } from '$lib/server/attestations/verify';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database } from '$lib/server/db';
import { readOwnResumes } from '$lib/server/resumes/read';
import { selfCandidate } from '$lib/server/resumes/deps';
import { experienceMonths, listManualExperience, type ManualExperience } from './experience';
import { readOwnProfile, type OwnProfile } from './fields';
import { readSuggestions, type SuggestionView } from './suggestions';

export interface AttestationView {
	handle: string;
	categoryId: string;
	holderCode: string;
	issuedAt: Date;
	status: AttestationStatus;
}

export interface OwnProfileView {
	profile: OwnProfile;
	experience: ManualExperience[];
	experienceMonths: number;
	suggestions: SuggestionView[];
	attestations: AttestationView[];
}

export async function ownProfileView(
	deps: { db: Database; crypto: FieldCrypto; now: () => Date },
	subject: AccessSubject
): Promise<OwnProfileView> {
	const { candidateId } = selfCandidate(subject);
	const [profile, experience, resumes, issued] = await Promise.all([
		readOwnProfile(deps.db, deps.crypto, candidateId),
		listManualExperience(deps.db, candidateId),
		readOwnResumes(deps.db, subject),
		ownAttestations(deps.db, candidateId)
	]);
	const document = resumes.current?.document ?? null;
	const suggestions = document === null ? [] : await readSuggestions(deps.db, deps.crypto, candidateId, document);
	const attestations: AttestationView[] = [];
	for (const attestation of issued) {
		const verified = await verifyAttestation(deps.db, attestation.handle);
		if (!verified) throw new Error(`own confirmation ${attestation.handle} is not found by its handle`);
		attestations.push({ ...attestation, status: verified.status });
	}
	return {
		profile,
		experience,
		experienceMonths: experienceMonths(experience, deps.now()),
		suggestions,
		attestations
	};
}
