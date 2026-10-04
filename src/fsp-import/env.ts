// The import command is a plain Node process: its build (bundle.config.ts next to this file) resolves
// `$env/dynamic/private` to this module, so `config()` reads the process environment as in the application.
export const env: Record<string, string | undefined> = process.env;
