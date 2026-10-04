// Who sends the request, as established by authentication (docs/contracts.md, section 5.2).
import type { Permission } from './permissions';

export type Actor =
	| { kind: 'anonymous' }
	| {
			kind: 'session';
			userId: string;
			/** SHA-256 of the session id: the key of the session in Redis. */
			sessionHash: string;
			authTime: Date;
			authMethod: 'password' | 'fsp_id';
			/** Token the browser echoes in `X-CSRF-Token` on state-changing requests. */
			csrfToken: string;
	  }
	| {
			kind: 'api_key';
			apiKeyId: string;
			companyId: string;
			/** Membership of the key creator; the key acts on its behalf. */
			memberId: string;
			userId: string;
			permissions: readonly Permission[];
	  };
