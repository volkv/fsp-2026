// The object storage for integration tests: the image and the command of the `storage` service of compose.yaml, the
// bucket created by the storage itself at start, as on the stand.
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { S3Settings } from '$lib/server/storage/object-store';
import { STORAGE_IMAGE } from './images';

const S3_PORT = 8333;

export interface TestStorage {
	container: StartedTestContainer;
	/** Settings of `S3ObjectStore` for the bucket of the test. */
	settings: S3Settings;
}

export async function startStorage(): Promise<TestStorage> {
	const credentials = { accessKeyId: 'storage-test', secretAccessKey: 'storage-test-secret' };
	const bucket = 'fsp-files-test';
	const container = await new GenericContainer(STORAGE_IMAGE)
		.withCommand([
			'mini',
			'-dir=/data',
			'-ip=127.0.0.1',
			'-ip.bind=0.0.0.0',
			'-s3.autoCreateBucket=false',
			'-webdav=false',
			'-admin.ui=false',
			'-s3.port.iceberg=0',
			'-s3.port.lance=0'
		])
		.withEnvironment({
			AWS_ACCESS_KEY_ID: credentials.accessKeyId,
			AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
			S3_BUCKET: bucket
		})
		.withExposedPorts(S3_PORT)
		// The S3 API answers before the bucket exists; ready once both hold, as the compose healthcheck.
		.withWaitStrategy(
			Wait.forSuccessfulCommand(
				`wget -q -O /dev/null http://127.0.0.1:${S3_PORT}/healthz && wget -q -O /dev/null http://127.0.0.1:8888/buckets/${bucket}/`
			)
		)
		.withStartupTimeout(60_000)
		.start();
	return {
		container,
		settings: {
			endpoint: `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`,
			region: 'us-east-1',
			bucket,
			...credentials
		}
	};
}
