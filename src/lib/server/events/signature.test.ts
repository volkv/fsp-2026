import { describe, expect, it } from 'vitest';
import { webhookSignature } from './signature';

describe('webhookSignature', () => {
	it('matches the reference vector of the Standard Webhooks specification', () => {
		expect(
			webhookSignature(
				'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
				'msg_p5jXN8AQM9LWM0D4loKWxJek',
				1614265330,
				'{"test": 2432232314}'
			)
		).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
	});

	it('signs the id and the moment with the body: a replayed body under another id or time does not verify', () => {
		const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
		const signed = webhookSignature(secret, 'msg_1', 1614265330, '{}');
		expect(webhookSignature(secret, 'msg_2', 1614265330, '{}')).not.toBe(signed);
		expect(webhookSignature(secret, 'msg_1', 1614265331, '{}')).not.toBe(signed);
	});

	it('refuses a secret without the prefix rather than keying by its text', () => {
		expect(() => webhookSignature('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg', 1, '{}')).toThrow(/whsec_/);
	});
});
