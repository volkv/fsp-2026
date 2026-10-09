// The resume parser of the tests: the image compose runs, started as compose.yaml runs it — read-only, its scratch space
// in tmpfs, the contract's memory. Resumes of the tests are real PDF, DOCX and text files, so they go through the real
// parser, not an imitation of it.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DocparseClient } from '$lib/server/documents/docparse';

const DOCPARSE_DIR = fileURLToPath(new URL('../../services/docparse', import.meta.url));
const DOCPARSE_IMAGE = 'fsp-docparse:test';

/** The fixtures of the parser's own tests: PDF, DOCX, RTF and scans. */
export const DOCPARSE_FIXTURES = `${DOCPARSE_DIR}/tests/fixtures`;

class ParserContainer extends GenericContainer {
	constructor() {
		super(DOCPARSE_IMAGE);
		this.withExposedPorts(8000)
			.withTmpFs({ '/tmp': 'size=512m,mode=1777' })
			.withDroppedCapabilities('ALL')
			.withSecurityOpt('no-new-privileges:true')
			.withResourcesQuota({ memory: 0.75, cpu: 2 })
			.withWaitStrategy(Wait.forHttp('/v1/health', 8000))
			.withStartupTimeout(60_000);
		this.hostConfig.ReadonlyRootfs = true;
	}
}

export interface StartedParser {
	container: StartedTestContainer;
	client: DocparseClient;
}

/** Builds the runtime stage (sharing the build cache with `docker compose build`) and starts the parser. */
export async function startParser(): Promise<StartedParser> {
	await promisify(execFile)(
		'docker',
		['build', '--quiet', '--target', 'runtime', '--tag', DOCPARSE_IMAGE, DOCPARSE_DIR],
		{ maxBuffer: 16 * 1024 * 1024 }
	);
	const container = await new ParserContainer().start();
	// The container keeps the service's default of two parses at a time.
	const url = `http://${container.getHost()}:${container.getMappedPort(8000)}`;
	return { container, client: new DocparseClient(url, 2) };
}
