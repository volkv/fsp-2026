// The calendar of the product: dates are days in Moscow time, on the pages and in the records that carry a day.

export const PRODUCT_TIME_ZONE = 'Europe/Moscow';

const isoDay = new Intl.DateTimeFormat('en-CA', {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	timeZone: PRODUCT_TIME_ZONE
});

/** The day of a moment in the product time zone, `YYYY-MM-DD`: 2026-10-07T22:30Z is 2026-10-08. */
export function productDay(moment: Date): string {
	return isoDay.format(moment);
}
