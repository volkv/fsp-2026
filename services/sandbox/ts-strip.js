// Compile step of the `typescript` language: erases type annotations (Node's strip-only mode) and writes plain
// JavaScript. Syntax that needs a transform (enum, namespace, parameter properties) is a compile error, as in Node.
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const [source, target] = process.argv.slice(2);
try {
	writeFileSync(target, stripTypeScriptTypes(readFileSync(source, 'utf8'), { mode: 'strip' }));
} catch (error) {
	if (!(error instanceof SyntaxError)) throw error;
	process.stderr.write(`${source}: ${error.message}\n`);
	process.exit(1);
}
