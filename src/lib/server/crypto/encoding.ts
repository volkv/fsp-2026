const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 in lowercase without padding: identifiers safe for URLs and case-insensitive input. */
export function base32(bytes: Uint8Array): string {
	let output = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
			bits -= 5;
		}
		// Keep only the bits not yet written, so the accumulator never overflows 32 bits.
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) output += ALPHABET.charAt((buffer << (5 - bits)) & 31);
	return output;
}
