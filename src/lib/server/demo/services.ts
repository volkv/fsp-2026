// What the demo seed and reset work with. The CLI and the worker build it from the configuration; tests pass their
// own. Letters the product sends while the seed acts for people (a representative's invitation, a member's
// invitation) are kept by the seed instead of being mailed: the seed follows their links itself.
import type { Config } from '$lib/server/config';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database } from '$lib/server/db';
import type { Docparse } from '$lib/server/documents/docparse';
import type { FspIntegration } from '$lib/server/fsp/integration';
import type { JobLogger } from '$lib/server/jobs/log';
import type { Mailer, MailMessage } from '$lib/server/mail/mailer';
import type { Redis } from '$lib/server/redis';
import type { ObjectStore } from '$lib/server/storage/object-store';

type DemoSettings = NonNullable<Config['demo']>;

export interface DemoServices {
	db: Database;
	redis: Redis;
	crypto: FieldCrypto;
	store: ObjectStore;
	parser: Docparse;
	fsp: FspIntegration;
	/** Issuer of FSP ID: external identities of the linked athletes. */
	fspIdIssuer: string;
	/** Origin of the simulator's control endpoints. */
	fspMockOrigin: string;
	settings: DemoSettings;
	appOrigin: string;
	/** `seeds/` directory. */
	seedsDir: string;
	log: JobLogger;
}

/** A mailer that keeps the letters: the seed reads the links the product would send to a person. */
export class LetterBox implements Mailer {
	readonly #letters: MailMessage[] = [];

	send(message: MailMessage): Promise<{ ok: true; value: { messageId: string } }> {
		this.#letters.push(message);
		return Promise.resolve({ ok: true, value: { messageId: `demo-${this.#letters.length}` } });
	}

	/** The token of the last letter to the address that carries a link with `token=`. */
	tokenFor(address: string): string {
		const letter = this.#letters.findLast((l) => l.to === address);
		const token = letter ? /[?&]token=([^&\s"<>]+)/.exec(letter.text)?.[1] : undefined;
		if (token === undefined) throw new Error(`no letter with a link was sent to ${address}`);
		return decodeURIComponent(token);
	}
}
