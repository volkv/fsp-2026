// Batch variants of the FSP results source (docs/contracts.md 1.7): an export file (CSV, XLSX) and protocols (PDF, DOCX,
// ODT, RTF) read through `docparse`. Both give competitions and result rows of one model with a completeness of the whole batch;
// nothing here touches the database, so a batch can be checked before it is imported.
import { createHash } from 'node:crypto';
import type { Docparse } from '$lib/server/documents/docparse';
import { detectFormat } from '$lib/server/storage/signature';
import type { AdapterResult } from '../types';
import { readCsv } from './csv';
import type { MappingProfile } from './profile';
import { readProtocol } from './protocol';
import { mapRows, type MappedRows } from './rows';
import { BatchFormatError } from './table';
import { readXlsx } from './xlsx';

type BatchVariant = 'file' | 'pdf-protocols';

/**
 * Formats of a protocol: those whose tables the parser reports (contracts 4.2). A legacy DOC is not among them: its
 * signature is the one of a legacy XLS export, which is not a protocol.
 */
const PROTOCOL_FORMATS = ['pdf', 'docx', 'odt', 'rtf'] as const;
type ProtocolFormat = (typeof PROTOCOL_FORMATS)[number];

function protocolFormat(bytes: Uint8Array): ProtocolFormat | null {
	const format = detectFormat(bytes);
	return (PROTOCOL_FORMATS as readonly string[]).includes(format ?? '') ? (format as ProtocolFormat) : null;
}

type BatchIncompleteReason = 'not_declared_complete' | 'row_issues' | 'parser_partial';

export interface ResultsBatch extends MappedRows {
	variant: BatchVariant;
	profile: string;
	/** SHA-256 of the file: the snapshot hash of the facts it gives. */
	sha256: string;
	format: 'csv' | 'xlsx' | ProtocolFormat;
	/**
	 * `competition` — the batch lists every result of its competitions, so a record absent from it leaves;
	 * `partial` — it does not, and nothing is withdrawn.
	 */
	completeness: {
		complete: boolean;
		scope: 'competition' | 'partial';
		sourceVersion: string;
		incompleteReason?: BatchIncompleteReason;
	};
	/** A protocol read by OCR: its text may hold recognition errors. */
	ocrUsed: boolean;
}

type FeedErrorCode = 'unsupported_format' | 'mapping_required' | 'protocol_error' | 'limit_exceeded' | 'unavailable';

interface ReadBatchInput {
	bytes: Uint8Array<ArrayBuffer>;
	declaredName: string;
	profile: MappingProfile;
	/** The operator states that an export lists every result of its competitions; a protocol always does. */
	declaredComplete: boolean;
	requestId: string;
	signal?: AbortSignal;
}

interface ResultsFeed {
	readonly variant: BatchVariant;
	readBatch(input: ReadBatchInput): Promise<AdapterResult<ResultsBatch, FeedErrorCode>>;
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fail(code: FeedErrorCode, retryable: boolean, message: string) {
	return { ok: false as const, error: { code, retryable, message } };
}

function completeness(
	variant: BatchVariant,
	sha256: string,
	complete: boolean,
	reason: BatchIncompleteReason | undefined
): ResultsBatch['completeness'] {
	const sourceVersion = `${variant}:${sha256}`;
	return complete && reason === undefined
		? { complete: true, scope: 'competition', sourceVersion }
		: { complete: false, scope: 'partial', sourceVersion, incompleteReason: reason ?? 'not_declared_complete' };
}

function isZip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const fileFeed: ResultsFeed = {
	variant: 'file',
	readBatch(input) {
		const { bytes, profile } = input;
		const sha256 = sha256Of(bytes);
		if (protocolFormat(bytes) !== null) {
			return Promise.resolve(fail('unsupported_format', false, 'документ читается как протокол, а не как выгрузка'));
		}
		const format = isZip(bytes) ? 'xlsx' : 'csv';
		try {
			const table =
				format === 'xlsx'
					? readXlsx(bytes, { ...profile.xlsx, headerRow: profile.headerRow })
					: readCsv(bytes, { ...profile.csv, headerRow: profile.headerRow });
			const mapped = mapRows({ table, profile, recordKey: { kind: 'athlete', sha256 } });
			const reason = !input.declaredComplete
				? 'not_declared_complete'
				: mapped.issues.length > 0
					? 'row_issues'
					: undefined;
			return Promise.resolve({
				ok: true,
				value: {
					...mapped,
					variant: 'file',
					profile: profile.name,
					sha256,
					format,
					completeness: completeness('file', sha256, input.declaredComplete, reason),
					ocrUsed: false
				}
			});
		} catch (error) {
			if (error instanceof BatchFormatError) return Promise.resolve(fail(error.code, false, error.message));
			throw error;
		}
	}
};

/** Protocols through the parsing service; its failures keep their retry sense (contracts 4.4). */
function protocolFeed(parser: () => Docparse): ResultsFeed {
	return {
		variant: 'pdf-protocols',
		async readBatch(input) {
			const { bytes, profile } = input;
			const format = protocolFormat(bytes);
			if (format === null) return fail('unsupported_format', false, 'протокол — это PDF, DOCX, ODT или RTF');
			const sha256 = sha256Of(bytes);
			const parsed = await parser().parse({
				bytes,
				declaredName: input.declaredName,
				requestId: input.requestId,
				...(input.signal ? { signal: input.signal } : {})
			});
			if (!parsed.ok) {
				const { code, retryable, message } = parsed.error;
				if (code === 'invalid_response') {
					return fail('protocol_error', false, `сервис разбора ответил не по контракту (${message})`);
				}
				if (retryable || code === 'unavailable' || code === 'cancelled') {
					return fail('unavailable', retryable, `сервис разбора недоступен (${code}: ${message})`);
				}
				return fail('unsupported_format', false, `протокол не читается: ${code}`);
			}
			try {
				const protocol = readProtocol(parsed.value, profile);
				const mapped = mapRows({
					table: protocol.table,
					profile,
					recordKey: { kind: 'protocol', sha256 },
					hints: protocol.hints,
					...(protocol.columns ? { columns: protocol.columns } : {})
				});
				const issues = [...protocol.issues, ...mapped.issues].sort((a, b) => a.row - b.row);
				const reason =
					parsed.value.status === 'partial' ? 'parser_partial' : issues.length > 0 ? 'row_issues' : undefined;
				return {
					ok: true,
					value: {
						...mapped,
						rowsRead: mapped.rowsRead + protocol.issues.length,
						issues,
						variant: 'pdf-protocols',
						profile: profile.name,
						sha256,
						format,
						completeness: completeness('pdf-protocols', sha256, true, reason),
						ocrUsed: parsed.value.flags.ocrUsed
					}
				};
			} catch (error) {
				if (error instanceof BatchFormatError) return fail(error.code, false, error.message);
				throw error;
			}
		}
	};
}

/**
 * The variant a file belongs to by its content, not its name: a document (PDF, DOCX, ODT, RTF) is a protocol, anything
 * else an export.
 */
export function feedFor(bytes: Uint8Array, parser: () => Docparse): ResultsFeed {
	return protocolFormat(bytes) !== null ? protocolFeed(parser) : fileFeed;
}
