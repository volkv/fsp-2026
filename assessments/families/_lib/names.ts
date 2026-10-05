// Pools of surface values: identifiers and plots that change between instances and never change the path of a
// solution.
export const LIST_NAMES = ['handlers', 'hooks', 'steps', 'rules', 'actions', 'jobs', 'tasks', 'filters'] as const;
export const VAR_NAMES = ['i', 'k', 'n', 'j', 'idx', 'step', 'level', 'shift'] as const;
export const ARG_NAMES = ['x', 'v', 'value', 'amount', 'base', 'qty'] as const;
export const FUNC_NAMES = ['make', 'build', 'create', 'factory', 'wrap', 'bind'] as const;
export const ENTITY_NAMES = [
	'orders',
	'users',
	'payments',
	'tickets',
	'events',
	'items',
	'invoices',
	'sessions'
] as const;
export const CITY_NAMES = [
	'Казань',
	'Омск',
	'Тверь',
	'Самара',
	'Пермь',
	'Томск',
	'Сочи',
	'Уфа',
	'Курск',
	'Тула'
] as const;
export const PERSON_NAMES = [
	'anna',
	'boris',
	'vera',
	'gleb',
	'dina',
	'egor',
	'zoya',
	'ilya',
	'kira',
	'lev',
	'mila',
	'oleg',
	'pavel',
	'rita',
	'sasha',
	'timur'
] as const;
