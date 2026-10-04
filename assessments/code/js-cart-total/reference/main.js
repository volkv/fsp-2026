import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));

const subtotal = input.items.reduce((sum, item) => sum + item.price * item.qty, 0);

function discountOf(code) {
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

let coupon = null;
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
const rub = (kopecks) => `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, '0')}`;

console.log(
	[
		`subtotal: ${rub(subtotal)}`,
		`coupon: ${coupon ?? '-'}`,
		`discount: ${rub(discount)}`,
		`delivery: ${rub(delivery)}`,
		`total: ${rub(total)}`
	].join('\n')
);
