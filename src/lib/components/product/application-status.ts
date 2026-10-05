// How the statuses of an application read on the pages of the candidate and of the company.
export const APPLICATION_STATUS = {
	submitted: { label: 'Отправлен', tone: 'info' },
	viewed: { label: 'Просмотрен', tone: 'neutral' },
	invited: { label: 'Приглашение', tone: 'success' },
	rejected: { label: 'Отказ', tone: 'neutral' },
	withdrawn: { label: 'Отозван', tone: 'neutral' }
} as const satisfies Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }>;
