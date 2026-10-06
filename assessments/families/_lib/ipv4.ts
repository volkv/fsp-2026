// IPv4 addresses of network items as unsigned 32-bit numbers: written in dotted form, built from octets, cut to the
// network of a prefix. Plain arithmetic, not bit operators: JavaScript bit operators work on signed 32-bit values.

/** The dotted form of an address. */
export const toIp = (n: number): string =>
	[Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');

/** The address of four octets. */
export const ip = (a: number, b: number, c: number, d: number): number => ((a * 256 + b) * 256 + c) * 256 + d;

/** Addresses in a block of the prefix length. */
export const blockSize = (prefix: number): number => 2 ** (32 - prefix);

/** The network address of an address under a prefix length. */
export const netOf = (address: number, prefix: number): number => address - (address % blockSize(prefix));
