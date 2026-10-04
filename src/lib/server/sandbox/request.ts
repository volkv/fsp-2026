// Validation of a run request (docs/contracts.md, sections 6.1 and 6.2). A request outside these bounds is a
// configuration error of the task (`invalid_request`), never something the candidate caused.
import { z } from 'zod';
import type { RunRequest } from './types';

export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_TESTS = 50;
/** Input of one test; go-judge receives it inline, and the gateway caps a request body at 10 MB. */
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/**
 * Upper bounds of the limits a task may set. Two programs run at once in a container of 1.5 GB (compose.yaml), and
 * the program's /w and /tmp count towards its memory, so one program gets at most 512 MB.
 */
export const LIMIT_BOUNDS = {
	cpuTimeMs: { min: 100, max: 10_000 },
	wallTimeMs: { min: 100, max: 20_000 },
	memoryMb: { min: 16, max: 512 },
	outputKb: { min: 1, max: 1024 },
	processes: { min: 1, max: 64 },
	compileCpuTimeMs: { min: 1_000, max: 30_000 },
	compileMemoryMb: { min: 64, max: 512 }
} as const;

const bounded = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max);

const utf8Bytes = (max: number) =>
	z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= max, { message: `must be at most ${max} bytes` });

const checkerSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('exact') }).strict(),
	z.object({ kind: z.literal('tokens') }).strict(),
	z.object({ kind: z.literal('float_eps'), eps: z.number().positive().max(1) }).strict()
]);

export const runRequestSchema = z
	.object({
		requestId: z.string().min(1).max(128),
		language: z.string().min(1).max(64),
		source: utf8Bytes(MAX_SOURCE_BYTES).refine((value) => value.trim() !== '', { message: 'must not be empty' }),
		tests: z
			.array(
				z
					.object({
						id: z.string().min(1).max(128),
						stdin: utf8Bytes(MAX_STDIN_BYTES),
						expected: z.string(),
						hidden: z.boolean()
					})
					.strict()
			)
			.min(1)
			.max(MAX_TESTS)
			.refine((tests) => new Set(tests.map((test) => test.id)).size === tests.length, {
				message: 'test ids must be unique'
			}),
		limits: z
			.object({
				cpuTimeMs: bounded(LIMIT_BOUNDS.cpuTimeMs),
				wallTimeMs: bounded(LIMIT_BOUNDS.wallTimeMs),
				memoryMb: bounded(LIMIT_BOUNDS.memoryMb),
				outputKb: bounded(LIMIT_BOUNDS.outputKb),
				processes: bounded(LIMIT_BOUNDS.processes),
				compileCpuTimeMs: bounded(LIMIT_BOUNDS.compileCpuTimeMs),
				compileMemoryMb: bounded(LIMIT_BOUNDS.compileMemoryMb)
			})
			.strict(),
		checker: checkerSchema
	})
	.strict() satisfies z.ZodType<RunRequest>;

/** Issue paths and messages only: the request carries code and test data that must not reach logs. */
export function describeIssues(error: z.ZodError): { path: string; message: string }[] {
	return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
