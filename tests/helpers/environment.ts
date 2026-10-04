// A complete valid environment for code that reads `config()`; tests override the service URLs.
const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

export function testEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		DATABASE_URL: 'postgres://app:app@localhost:5432/app',
		REDIS_URL: 'redis://localhost:6379',
		APP_ORIGIN: 'http://localhost:57173',
		FIELD_ENCRYPTION_KEYS: `1:${key(1)}`,
		FIELD_ENCRYPTION_ACTIVE_KEY: '1',
		FIELD_HMAC_SECRET: key(2),
		RECEIPT_SIGNING_KEYS: `test-1:${key(3)}`,
		RECEIPT_ACTIVE_SIGNING_KEY: 'test-1',
		S3_ENDPOINT: 'http://localhost:9000',
		S3_REGION: 'us-east-1',
		S3_ACCESS_KEY_ID: 'test',
		S3_SECRET_ACCESS_KEY: 'test-secret',
		S3_BUCKET: 'fsp-files',
		SMTP_URL: 'smtp://localhost:1025',
		MAIL_FROM: 'test@example.org',
		DOCPARSE_URL: 'http://localhost:8080',
		SANDBOX_URL: 'http://localhost:8081',
		...overrides
	};
}
