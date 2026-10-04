/** A user of the simulated FSP ID. For athletes `sub` equals `fspId` in the achievements API. */
export interface Account {
	sub: string;
	email: string;
	givenName: string;
	familyName: string;
	preferredUsername: string;
	kind: 'athlete' | 'no_athlete_profile' | 'employer' | 'fsp_operator';
}

/** Demo account shown first on the login page, with the scenario it covers. */
export interface DemoAccount {
	sub: string;
	title: string;
	scenario: string;
}

export interface AccountDirectory {
	get(sub: string): Account | undefined;
	/** Case-insensitive search by name, username or subject, without the `excluded` subjects; at most `limit` results. */
	search(query: string, limit: number, excluded: ReadonlySet<string>): Account[];
	demo(): readonly DemoAccount[];
}

export function displayName(account: Account): string {
	return `${account.familyName} ${account.givenName}`;
}
