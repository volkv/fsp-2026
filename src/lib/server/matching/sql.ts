// SQL fragments shared by the matching queries.
import { sql, type SQL } from 'drizzle-orm';

/** `(a, b, c)` of text parameters for `IN`; an empty list is a caller error, not «matches nothing». */
export function textList(values: readonly string[]): SQL {
	if (values.length === 0) throw new Error('an IN list must not be empty');
	return sql`(${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `
	)})`;
}
