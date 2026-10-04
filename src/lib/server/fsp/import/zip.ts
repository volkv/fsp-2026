// The ZIP container of an XLSX: the central directory and the members a workbook needs, stored or deflated. Sizes
// are bounded before and during inflation, so a crafted archive cannot expand beyond the limits; encrypted members,
// ZIP64 and other compression methods are refused.
import { inflateRawSync } from 'node:zlib';
import { BatchFormatError, TABLE_LIMITS } from './table';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 5_000;

interface Entry {
	method: number;
	encrypted: boolean;
	compressedSize: number;
	size: number;
	localOffset: number;
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '').replace('.', ',');

const corrupt = (message: string) => new BatchFormatError('unsupported_format', `архив XLSX повреждён: ${message}`);

export class ZipArchive {
	readonly #bytes: Buffer;
	readonly #entries = new Map<string, Entry>();

	constructor(bytes: Uint8Array) {
		this.#bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const buf = this.#bytes;
		let eocd = -1;
		for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
			if (buf.readUInt32LE(i) === EOCD) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw corrupt('нет конца центрального каталога');
		const count = buf.readUInt16LE(eocd + 10);
		const directoryOffset = buf.readUInt32LE(eocd + 16);
		if (count === 0xffff || directoryOffset === 0xffffffff) {
			throw new BatchFormatError('unsupported_format', 'книги в формате ZIP64 не поддерживаются');
		}
		if (count > MAX_ENTRIES) throw new BatchFormatError('unsupported_format', 'в XLSX слишком много частей');
		let at = directoryOffset;
		for (let n = 0; n < count; n++) {
			if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw corrupt('запись центрального каталога');
			const nameLength = buf.readUInt16LE(at + 28);
			const next = at + 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
			if (next > buf.length) throw corrupt('запись центрального каталога');
			const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
			this.#entries.set(name, {
				encrypted: (buf.readUInt16LE(at + 8) & 1) === 1,
				method: buf.readUInt16LE(at + 10),
				compressedSize: buf.readUInt32LE(at + 20),
				size: buf.readUInt32LE(at + 24),
				localOffset: buf.readUInt32LE(at + 42)
			});
			at = next;
		}
	}

	has(name: string): boolean {
		return this.#entries.has(name);
	}

	/** The member's bytes; its declared and actual sizes must agree and stay within the limit. */
	read(name: string): Buffer {
		const entry = this.#entries.get(name);
		if (!entry) throw corrupt(`нет части ${name}`);
		if (entry.encrypted) throw new BatchFormatError('unsupported_format', 'XLSX зашифрован');
		if (entry.size > TABLE_LIMITS.partBytes) {
			throw new BatchFormatError(
				'limit_exceeded',
				`часть книги ${name} распаковывается в ${mib(entry.size)} МиБ, допустимо до ${mib(TABLE_LIMITS.partBytes)} МиБ: разделите пакет на части`
			);
		}
		const buf = this.#bytes;
		const at = entry.localOffset;
		if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw corrupt(`локальный заголовок ${name}`);
		const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
		const end = start + entry.compressedSize;
		if (end > buf.length) throw corrupt(`данные ${name}`);
		const data = buf.subarray(start, end);
		let content: Buffer;
		if (entry.method === 0) {
			content = data;
		} else if (entry.method === 8) {
			try {
				content = inflateRawSync(data, { maxOutputLength: entry.size + 1 });
			} catch (error) {
				// zlib reports a damaged stream with a code, an output beyond the limit with a RangeError.
				if (error instanceof RangeError || (error instanceof Error && 'code' in error)) {
					throw corrupt(`часть ${name} не распаковывается в заявленный размер`);
				}
				throw error;
			}
		} else {
			throw new BatchFormatError('unsupported_format', `часть ${name} сжата неподдерживаемым способом`);
		}
		if (content.length !== entry.size) throw corrupt(`часть ${name} не совпадает с заявленным размером`);
		return content;
	}
}
