import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, parseAuditDetails } from './events';

describe('audit event catalog', () => {
	it('lists every event once', () => {
		expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
		expect(AUDIT_ACTIONS).toContain('operator.case_access');
	});

	it('accepts codes and identifiers', () => {
		expect(parseAuditDetails('card.viewed', { pseudonym: 'abcdefgh', projection: 'catalog' })).toEqual({
			pseudonym: 'abcdefgh',
			projection: 'catalog'
		});
		expect(parseAuditDetails('auth.logout', null)).toBeNull();
	});

	it('refuses free text such as a resume fragment or a message', () => {
		expect(() => parseAuditDetails('invitation.sent', { message: 'Добрый день, предлагаем работу' })).toThrow();
		expect(() => parseAuditDetails('file.downloaded', { name: 'Резюме Иванова.pdf' })).toThrow();
	});

	it('requires the details the model names', () => {
		expect(() => parseAuditDetails('auth.login', null)).toThrow(/requires details/);
		expect(() => parseAuditDetails('auth.login', { method: 'magic' })).toThrow();
		expect(parseAuditDetails('auth.login', { method: 'fsp_id' })).toEqual({ method: 'fsp_id' });
	});
});
