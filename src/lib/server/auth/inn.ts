// Taxpayer number (ИНН) check digits: 10 digits for an organisation, 12 for an individual entrepreneur (domain 5.1).

const WEIGHTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const WEIGHTS_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const WEIGHTS_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigit(digits: readonly number[], weights: readonly number[]): number {
	const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
	return (sum % 11) % 10;
}

export function isValidInn(value: string): boolean {
	if (!/^(\d{10}|\d{12})$/.test(value)) return false;
	const digits = Array.from({ length: value.length }, (_, index) => value.charCodeAt(index) - 48);
	if (digits.length === 10) return checkDigit(digits, WEIGHTS_10) === digits[9];
	return checkDigit(digits, WEIGHTS_11) === digits[10] && checkDigit(digits, WEIGHTS_12) === digits[11];
}
