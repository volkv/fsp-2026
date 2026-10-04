import { readFileSync } from 'node:fs';

interface Item {
	sku: string;
	price: number;
	qty: number;
}

interface Cart {
	items: Item[];
	coupons: string[];
}

const input = JSON.parse(readFileSync(0, 'utf8')) as Cart;

const subtotal = input.items.reduce((sum, item) => sum + item.price * item.qty, 0);

function discountOf(code: string): number | null {
	let match = /^PERCENT([1-9]\d*)$/.exec(code);
	if (match) {
		const percent = Number(match[1]);
		return percent <= 50 ? Math.floor((subtotal * percent) / 100) : null;
	}
	match = /^MINUS([1-9]\d*)$/.exec(code);
	if (match) {
		const amount = Number(match[1]);
		return amount <= 10_000_000 ? Math.min(amount, subtotal) : null;
	}
	return null;
}

let coupon: string | null = null;
let discount = 0;
for (const code of input.coupons) {
	const value = discountOf(code);
	if (value !== null && (coupon === null || value > discount)) {
		coupon = code;
		discount = value;
	}
}

const delivery = subtotal === 0 || subtotal - discount >= 300_000 ? 0 : 29_900;
const total = subtotal - discount + delivery;
const rub = (kopecks: number): string => `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, '0')}`;

console.log(
	[
		`subtotal: ${rub(subtotal)}`,
		`coupon: ${coupon ?? '-'}`,
		`discount: ${rub(discount)}`,
		`delivery: ${rub(delivery)}`,
		`total: ${rub(total)}`
	].join('\n')
);
