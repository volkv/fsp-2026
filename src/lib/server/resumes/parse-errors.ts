// Why a resume parse gave no text (`resume_documents.parse_error`, docs/domain.md, section 15.2): the error codes of the
// parsing service (docs/contracts.md, section 4.4), the failures of its client, the failures of the platform itself
// around the stored file, the lapse of the ground of processing, and `unrecorded` for resumes that failed before the
// code was kept. Imported by relative path
// from the schema, so the module has no SvelteKit aliases.

export const RESUME_PARSE_ERRORS = [
	// The service.
	'unsupported_format',
	'too_large',
	'unpacked_too_large',
	'encrypted',
	'corrupt',
	'no_text',
	'timeout',
	'memory_exceeded',
	'busy',
	'internal',
	'bad_request',
	// Its client.
	'unavailable',
	'invalid_response',
	'cancelled',
	// The platform around the stored file.
	'object_missing',
	'storage_integrity',
	'storage_unavailable',
	'input_mismatch',
	// `pd_processing` was not in effect when the parse ran or when its result was written (revoked or lapsed).
	'no_processing_consent',
	// Failed before the code was recorded.
	'unrecorded'
] as const;

export type ResumeParseError = (typeof RESUME_PARSE_ERRORS)[number];

/** Parse statuses that carry an error code, and only they. */
export const FAILED_PARSE_STATUSES = ['failed', 'unsupported_format'] as const;
