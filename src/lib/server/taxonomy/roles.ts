// A job title as written → a role of the taxonomy (docs/domain.md, sections 9.5, 11, 13.2): one rule for the title of
// a resume entry, of an external posting and of a pasted vacancy. The title is matched against the role names of the
// version first, then against title patterns in order: the more specific role wins («Frontend тимлид» is a team lead,
// «Python-разработчик» is a backend developer). A key the version does not have is not returned; a title naming no
// role («программист», «инженер») stays without one — the rules do not guess a role from a generic word. A title
// inside a sentence is inflected («Ищем аналитика данных», «в команду дата-инженера», «на позицию тестировщика»): the
// job nouns are brought to the nominative before the patterns are matched, so the patterns are written once, in it.

/** Version of the title rules; the rules of resumes and of postings that use them name it in their own versions. */
export const ROLE_TITLE_RULES_VERSION = 'role-title/3';

export interface RoleName {
	key: string;
	nameRu: string;
}

/** A pattern starting at a word boundary: `\b` of JavaScript knows no Cyrillic letters. */
const w = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})`, 'u');

/** Order matters: the first matching pattern gives the role. */
export const ROLE_TITLE_RULES: readonly { role: string; pattern: RegExp }[] = [
	{ role: 'cto', pattern: w('cto(?![\\p{L}])|техническ\\p{L}* директор|chief technology') },
	{ role: 'presale', pattern: w('пре ?сейл|pre ?sales?(?![\\p{L}])') },
	{ role: 'delivery_manager', pattern: w('delivery (?:manager|lead|director)|head of delivery|деливери') },
	{
		role: 'product_manager',
		pattern: w('product manager|product owner|менеджер продукта|владел\\p{L}* продукта|продакт')
	},
	{ role: 'project_manager', pattern: w('project manager|руководитель проект|менеджер проект') },
	{ role: 'tech_writer', pattern: w('техническ\\p{L}* писатель|technical writer|tech writer') },
	{
		role: 'tech_support',
		pattern: w('техподдержк|техническ\\p{L}* поддержк|служб\\p{L}* поддержки|support engineer|helpdesk|service desk')
	},
	{ role: 'ui_ux_designer', pattern: w('дизайнер|designer|ux(?![\\p{L}])') },
	{
		role: 'team_lead',
		pattern: w(
			'team ?lead|тимлид|tech ?lead|техлид|head of|руководитель [^,/]*разработк|руководитель (?:группы|команды)'
		)
	},
	{ role: 'architect', pattern: w('архитектор|architect') },
	{ role: 'mlops', pattern: w('mlops') },
	{ role: 'cv_engineer', pattern: w('computer vision|компьютерн\\p{L}* зрени|cv engineer') },
	{ role: 'ml_engineer', pattern: w('ml(?![\\p{L}])|machine learning|машинн\\p{L}* обучени') },
	{ role: 'data_scientist', pattern: w('data scien|дата сайентист|специалист по данным|исследовател\\p{L}* данных') },
	{ role: 'data_engineer', pattern: w('data engineer|инженер данных|дата инженер|etl(?![\\p{L}])|dwh') },
	{ role: 'data_analyst', pattern: w('аналитик данных|data analyst|bi analyst|bi аналитик') },
	{ role: 'product_analyst', pattern: w('продуктов\\p{L}* аналитик|product analyst') },
	{ role: 'systems_analyst', pattern: w('системн\\p{L}* аналитик|systems? analyst') },
	{ role: 'business_analyst', pattern: w('бизнес аналитик|business analyst') },
	{
		role: 'sam_specialist',
		pattern: w(
			'sam(?![\\p{L}])|software asset|управлени\\p{L}* программными активами|лицензировани\\p{L}* по(?![\\p{L}])'
		)
	},
	{
		// Either order: «QA automation», «тестировщик-автоматизатор», «инженер по автоматизации тестирования».
		role: 'qa_automation',
		pattern: w(
			'(?:qa|тестиров\\p{L}*)\\s*(?:automation|автоматиз\\p{L}*)|автоматизац\\p{L}* тестировани|автотест|sdet|automation qa|aqa(?![\\p{L}])'
		)
	},
	{ role: 'qa_manual', pattern: w('тестировщик|qa(?![\\p{L}])|инженер по тестированию|tester|quality assurance') },
	{ role: 'devops', pattern: w('devops|девопс') },
	{ role: 'sre', pattern: w('sre(?![\\p{L}])|site reliability') },
	{ role: 'dba', pattern: w('dba(?![\\p{L}])|администратор баз данных|database administrator') },
	{ role: 'network_engineer', pattern: w('сетев\\p{L}* инженер|network engineer') },
	{ role: 'sysadmin', pattern: w('системн\\p{L}* администратор|сисадмин|sysadmin|system administrator') },
	{ role: 'pentester', pattern: w('пентест|pentest|penetration') },
	{ role: 'appsec', pattern: w('appsec|application security|безопасност\\p{L}* приложени') },
	{ role: 'soc_analyst', pattern: w('soc(?![\\p{L}])') },
	{ role: 'reverse_engineer', pattern: w('реверс|reverse engineer|вирусн\\p{L}* аналитик|malware') },
	{
		role: 'security_engineer',
		pattern: w('информационн\\p{L}* безопасност|security engineer|кибербезопасност|специалист по иб|инженер иб')
	},
	{ role: 'onec', pattern: w('1[сc](?![\\p{L}\\p{N}])') },
	{ role: 'gamedev', pattern: w('unity|unreal|gamedev|game developer|разработчик игр') },
	{ role: 'embedded', pattern: w('embedded|встраива|микроконтроллер|stm32|firmware|прошив') },
	{ role: 'robotics_engineer', pattern: w('робототехн|robotics') },
	{ role: 'uav_engineer', pattern: w('бпла|беспилотн|uav(?![\\p{L}])|drone') },
	{ role: 'mobile', pattern: w('android|ios(?![\\p{L}])|mobile|мобильн|flutter|react native|kotlin multiplatform') },
	{ role: 'fullstack', pattern: w('full ?stack|фулл? ?стек') },
	{
		role: 'frontend',
		pattern: w('front ?end|фронт ?енд|фронтенд|верстальщик|react(?![\\p{L}])|vue|angular|javascript|typescript')
	},
	{
		role: 'backend',
		pattern: w(
			'back ?end|бэк ?енд|бэкенд|бекенд|серверн\\p{L}* разработ|golang|go developer|go разработчик|разработчик на go(?![\\p{L}])|java(?![\\p{L}])|python|php|c#|\\.net|node\\.?js|ruby|scala|rust(?![\\p{L}])|elixir'
		)
	},
	{ role: 'systems_programmer', pattern: w('системн\\p{L}* программист|systems programmer|c\\+\\+|kernel') },
	{ role: 'algo_engineer', pattern: w('алгоритм|algorithm') }
];

/** Case, `ё`, dashes and underscores folded; whitespace collapsed. */
export function foldTitle(title: string): string {
	return title
		.normalize('NFKC')
		.toLowerCase()
		.replaceAll('ё', 'е')
		.replace(/[‐-―−_-]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

/**
 * Job nouns of titles with the endings of their cases and of the plural: «аналитика», «инженеру», «разработчиков»,
 * «руководителя». A noun of another word («разработка», «архитектура», «инженерия») does not end so.
 */
const JOB_NOUN =
	/(?<![\p{L}])(разработчик|программист|аналитик|инженер|тестировщик|автоматизатор|дизайнер|архитектор|администратор|сисадмин|менеджер|директор|специалист|верстальщик|тимлид|техлид|консультант|стажер|робототехник|пентестер|сайентист)(?:а|у|ом|е|ы|и|ов|ам|ами|ах)(?![\p{L}])/gu;
/** Nouns in «-тель»: «руководителя», «писателю», «исследователем». */
const TEL_NOUN = /(?<![\p{L}])(руководител|писател|исследовател)(?:я|ю|ем|е|и|ей|ям|ями|ях)(?![\p{L}])/gu;

/** A folded title with its job nouns in the nominative singular. */
function nominative(folded: string): string {
	return folded.replace(JOB_NOUN, '$1').replace(TEL_NOUN, '$1ь');
}

/** The role of a job title, or `null` when the title names no role of the version. */
export function roleOfTitle(title: string, roles: readonly RoleName[]): string | null {
	const folded = nominative(foldTitle(title));
	const byName = roles.find((role) => foldTitle(role.nameRu) === folded);
	if (byName) return byName.key;
	const known = new Set(roles.map((role) => role.key));
	return ROLE_TITLE_RULES.find((rule) => known.has(rule.role) && rule.pattern.test(folded))?.role ?? null;
}

/** Words that make a line a job title rather than a sentence or a company. */
export const TITLE_WORD =
	/(разработчик|программист|developer|engineer|инженер|аналитик|analyst|тестировщик|tester|\bqa\b|дизайнер|designer|архитектор|architect|тимлид|team ?lead|руководитель|менеджер|manager|администратор|administrator|devops|\bsre\b|верстальщик|scientist|специалист|стажер|стажёр|intern|\blead\b|head of|\bcto\b|консультант|consultant|писатель|writer)/iu;
