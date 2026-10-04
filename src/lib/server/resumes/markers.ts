// Responsibility markers of a resume (docs/domain.md, section 9.2): mentoring, leading a team, designing architecture.
// A marker is a signal of the grade axis only through the rule set; here it is recognised in the quoted phrase.
import type { Marker } from '$lib/server/categorization/params';

const MARKER_PATTERNS: readonly [Marker, RegExp][] = [
	[
		'mentoring',
		/(наставни\p{L}*|менторств\p{L}*|ментор\p{L}*|mentor\p{L}*|обучал\p{L}* (младших|новых|стажер|стажёр)\p{L}*)/iu
	],
	[
		'team_lead',
		/(руковод\p{L}*\s+(командой|группой|отделом|разработчиками|\d+\s+разработчик\p{L}*)|тимлид\p{L}*|team ?lead\p{L}*|led a team|managed a team|лидировал\p{L}* команд\p{L}*)/iu
	],
	[
		'architecture',
		/(архитектур\p{L}*|спроектировал\p{L}*|проектировани\p{L}* (систем|сервис)\p{L}*|designed the architecture|architected)/iu
	]
];

/** The first marker the text names and the phrase that names it, with its UTF-16 place in the text. */
export function findMarker(text: string): { marker: Marker; phrase: string; index: number } | null {
	let best: { marker: Marker; phrase: string; index: number } | null = null;
	for (const [marker, pattern] of MARKER_PATTERNS) {
		const match = pattern.exec(text);
		if (match && (best === null || match.index < best.index)) {
			best = { marker, phrase: match[0], index: match.index };
		}
	}
	return best;
}
