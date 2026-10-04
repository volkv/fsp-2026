// Command line of the bootstrap administrator (`node build/admin/main.js ensure [--reset-password]`, built by
// bundle.config.ts next to this file), run by the application image at every start: creates or confirms the
// administrator of BOOTSTRAP_ADMIN_EMAIL (ensure.ts). Without BOOTSTRAP_ADMIN_EMAIL it does nothing; an address of a
// demo account or of an account that is not active, a password the rules refuse, or no BOOTSTRAP_ADMIN_PASSWORD when
// the account is to be created stop the start. Once the account exists the password leaves the environment and the
// command confirms the role by the address alone. `--reset-password` sets the password of an existing account from
// BOOTSTRAP_ADMIN_PASSWORD again, which it then needs.
import { config } from '$lib/server/config';
import { fieldCrypto } from '$lib/server/crypto/fields';
import { closeDb, db } from '$lib/server/db';
import { createLogger } from '$lib/server/jobs/log';
import { closeRedis, redis } from '$lib/server/redis';
import { ensureBootstrapAdmin } from './ensure';

const log = createLogger({ component: 'admin-bootstrap' });

async function main(): Promise<void> {
	const [command, ...flags] = process.argv.slice(2);
	if (command !== 'ensure') throw new Error(`unknown command «${command ?? ''}»: ensure [--reset-password]`);
	const unknown = flags.filter((flag) => flag !== '--reset-password');
	if (unknown.length > 0) throw new Error(`unknown flags: ${unknown.join(' ')}`);
	const admin = config().bootstrapAdmin;
	if (admin === null) {
		log.info('bootstrap administrator is not configured');
		return;
	}
	const outcome = await ensureBootstrapAdmin(
		{ db: db(), crypto: fieldCrypto(), redis, now: () => new Date() },
		{
			email: admin.email,
			password: admin.password,
			resetPassword: flags.includes('--reset-password'),
			requestId: 'admin-cli:ensure'
		}
	);
	log.info('bootstrap administrator ensured', {
		user_id: outcome.userId,
		created: outcome.created,
		role_granted: outcome.roleGranted,
		password_set: outcome.passwordSet,
		sessions_revoked: outcome.sessionsRevoked
	});
}

main()
	.then(async () => {
		closeRedis();
		await closeDb();
	})
	.catch(async (error: unknown) => {
		log.error('bootstrap administrator command failed', {}, error);
		closeRedis();
		await closeDb();
		process.exitCode = 1;
	});
