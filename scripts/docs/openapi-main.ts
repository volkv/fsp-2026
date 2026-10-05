// Prints the OpenAPI document of `/api/v1` to stdout: the same call the `getOpenApiDocument` operation answers with.
// Bundled by openapi.bundle.config.ts; nothing here touches the database, the cache or the configuration.
import { openApiDocument } from '$lib/server/api/openapi';
import { API_OPERATIONS, EXTERNAL_ROUTES } from '$lib/server/api/v1';

process.stdout.write(JSON.stringify(openApiDocument(API_OPERATIONS, EXTERNAL_ROUTES)));
