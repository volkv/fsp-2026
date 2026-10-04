// Swagger UI of the public API on `/api/docs` (contracts 5.1): the page and its assets are served by the application
// itself — the bundle and styles of the `swagger-ui-dist` package and a local initializer, no external sources — under
// the same policy as the pages (`kit.csp` in vite.config.ts: scripts from self, styles from self and inline), plus
// `data:` images, which the Swagger UI styles use for their icons.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { CORE_CSP } from '$lib/server/http/security-headers';
import { API_BASE } from './operation';

export const DOCS_BASE = '/api/docs';

const INITIALIZER = `window.addEventListener('DOMContentLoaded', function () {
	window.ui = SwaggerUIBundle({
		url: '${API_BASE}/openapi.json',
		dom_id: '#swagger-ui',
		deepLinking: true,
		validatorUrl: null,
		presets: [SwaggerUIBundle.presets.apis],
		layout: 'BaseLayout',
		defaultModelsExpandDepth: 0,
		persistAuthorization: false
	});
});
`;

/** Files of the page: name → content type and where the content comes from. */
const ASSETS = {
	'swagger-ui.css': { type: 'text/css; charset=utf-8', source: { package: 'swagger-ui.css' } },
	'swagger-ui-bundle.js': { type: 'text/javascript; charset=utf-8', source: { package: 'swagger-ui-bundle.js' } },
	'init.js': { type: 'text/javascript; charset=utf-8', source: { inline: INITIALIZER } }
} as const satisfies Record<string, { type: string; source: { package: string } | { inline: string } }>;

export type DocsAsset = keyof typeof ASSETS;

export function isDocsAsset(name: string): name is DocsAsset {
	return Object.hasOwn(ASSETS, name);
}

/** The policy of the page: the page policy of the application with `data:` images for the Swagger UI icons. */
export const DOCS_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	CORE_CSP
].join('; ');

export const DOCS_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ФСП Карьера — API</title>
<link rel="stylesheet" href="${DOCS_BASE}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${DOCS_BASE}/swagger-ui-bundle.js"></script>
<script src="${DOCS_BASE}/init.js"></script>
</body>
</html>
`;

let packageDirectory: string | undefined;

/** The installed `swagger-ui-dist`, resolved at run time next to the server (the production image ships it). */
function swaggerUiDirectory(): string {
	packageDirectory ??= dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
	return packageDirectory;
}

export async function docsAsset(name: DocsAsset): Promise<{ type: string; body: string }> {
	const asset = ASSETS[name];
	const body =
		'inline' in asset.source
			? asset.source.inline
			: await readFile(join(swaggerUiDirectory(), asset.source.package), 'utf8');
	return { type: asset.type, body };
}
