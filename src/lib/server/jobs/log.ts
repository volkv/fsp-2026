// Structured log of the worker: one JSON object per line on stdout (errors on stderr), so that `docker compose logs`
// can be filtered by `job_id`, `job_type` or `request_id`. Fields carry identifiers and codes, never personal data.

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface JobLogger {
	info: (message: string, fields?: LogFields) => void;
	warn: (message: string, fields?: LogFields) => void;
	error: (message: string, fields?: LogFields, error?: unknown) => void;
	/** A logger that adds `fields` to every line. */
	child: (fields: LogFields) => JobLogger;
}

export type LogSink = (level: LogLevel, line: string) => void;

const consoleSink: LogSink = (level, line) => {
	if (level === 'error') console.error(line);
	else console.log(line);
};

function describeError(error: unknown): LogFields {
	if (error instanceof Error) {
		return { error_name: error.name, error_message: error.message, error_stack: error.stack ?? null };
	}
	return { error_message: String(error) };
}

export function createLogger(base: LogFields = {}, sink: LogSink = consoleSink): JobLogger {
	const write = (level: LogLevel, message: string, fields: LogFields = {}, error?: unknown) => {
		const entry = {
			ts: new Date().toISOString(),
			level,
			msg: message,
			...base,
			...fields,
			...(error === undefined ? {} : describeError(error))
		};
		sink(level, JSON.stringify(entry));
	};
	return {
		info: (message, fields) => {
			write('info', message, fields);
		},
		warn: (message, fields) => {
			write('warn', message, fields);
		},
		error: (message, fields, error) => {
			write('error', message, fields, error);
		},
		child: (fields) => createLogger({ ...base, ...fields }, sink)
	};
}
