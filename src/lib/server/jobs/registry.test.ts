import { describe, expect, it } from 'vitest';
import { JOB_TYPES, jobSpec, type JobType } from './registry';

const id = '0192f0e0-0000-7000-8000-000000000001';

describe('job registry', () => {
	it('builds the deduplication keys of the model', () => {
		const expectations: [JobType, Record<string, unknown>, string][] = [
			['resume.parse', { resume_document_id: id }, `resume.parse:${id}`],
			['evidence.compute', { candidate_id: id }, `evidence:${id}`],
			['match.refresh', { scope: 'vacancy', vacancy_id: id }, `match:vacancy:${id}`],
			['match.refresh', { scope: 'candidate', candidate_id: id }, `match:candidate:${id}`],
			['fsp.sync', { athlete_link_id: id }, `fsp.sync:${id}`],
			['external_profile.refresh', { external_profile_id: id }, `external_profile.refresh:${id}`],
			['notification.deliver', { notification_id: id, channel_id: id }, `notify:${id}:${id}`],
			['hiring.outcome_request', { process_id: id, reminder: 2 }, `hiring.outcome:${id}:2`],
			['account.purge', { user_id: id }, `purge:${id}`],
			['consent.revocation_cleanup', { consent_event_id: id }, `revocation:${id}`],
			['consent.revocation_cleanup', { athlete_link_id: id }, `revocation:link:${id}`],
			['demo.reset', { kind: 'nightly', date: '2026-10-12' }, 'demo.reset:nightly:2026-10-12'],
			['demo.reset', { kind: 'startup', date: '2026-10-12' }, 'demo.reset:startup:2026-10-12'],
			['demo.purge', { period: '2026-10-12T15' }, 'demo.purge:2026-10-12T15'],
			['vacancies.text_recheck', { validator_version: 'text-check/2' }, 'vacancies.text_recheck:text-check/2'],
			['challenge.deliver', { period: '2026-10-12T15' }, 'challenge.deliver:2026-10-12T15'],
			['confirmation.expire', { request_id: id }, `confirmation.expire:${id}`],
			['event.deliver', { delivery_id: id }, `event.deliver:${id}`]
		];
		for (const [type, payload, key] of expectations) {
			const spec = jobSpec(type);
			expect(spec.dedupKey(spec.payload.parse(payload))).toBe(key);
		}
	});

	it('refuses payloads with personal data or unknown fields', () => {
		expect(() => jobSpec('resume.parse').payload.parse({ resume_document_id: id, email: 'a@b.c' })).toThrow();
		expect(() => jobSpec('evidence.compute').payload.parse({ candidate_id: 'not-an-id' })).toThrow();
	});

	it('covers every type of the model registry', () => {
		expect(Object.keys(JOB_TYPES)).toHaveLength(28);
	});
});
