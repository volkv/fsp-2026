// The statement of a confirmation of a category (docs/domain.md, section 12.9): what the platform signs about one
// assignment — the specialization and the grade, the defining blocks the test confirmed, the confirmed stack, the
// versions of the catalog and of the bank release the decision was made on, the day of the decision and what the test
// does not check — and a commitment to the holder's name with a secret salt. No name, contact, candidate id or
// pseudonym is in it: the QR code of a PDF passed from hand to hand leads to it.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
	blockDefinition,
	CATALOG,
	gradeDefinition,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import type { ActiveCategory } from '$lib/server/categories/read';
import { normalizedFullName, type FullName } from '$lib/server/profile/contacts';

export const ATTESTATION_VERSION = 1;

/** What every confirmation says it does not confirm, besides what the test of the grade does not check. */
export const ATTESTATION_LIMITS = [
	'Подтверждение говорит о результате теста платформы, а не о личности предъявителя: принадлежность проверяется отдельно',
	'Опыт работы, резюме и мягкие навыки профиля подтверждением не проверяются'
] as const;

/**
 * `SHA-256(normalized name ‖ nonce)` in hex: the holder proves the confirmation is theirs by giving the name and the
 * salt; neither can be read from the commitment.
 */
export function holderCommitment(name: string, nonce: Uint8Array): string {
	return createHash('sha256').update(name, 'utf8').update(nonce).digest('hex');
}

export const commitmentOfName = (name: FullName, nonce: Uint8Array): string =>
	holderCommitment(normalizedFullName(name), nonce);

const day = (moment: Date): string => moment.toISOString().slice(0, 10);

/** The statement of an assignment, as signed. */
export function categoryStatement(
	category: ActiveCategory,
	input: { holderCommitment: string; issuer: string; signingKeyId: string; issuedAt: Date }
) {
	const definition = gradeDefinition(category.specialization, category.grade);
	return {
		attestation_version: ATTESTATION_VERSION,
		subject: 'category' as const,
		specialization: category.specialization,
		grade: category.grade,
		confirmed_blocks: category.confirmedBlocks.map((code) => ({ code, title: blockDefinition(code).title })),
		confirmed_skill_keys: [...category.confirmedSkillKeys].sort(),
		catalog_version: category.catalogVersion,
		bank_release_id: category.bankReleaseId,
		decided_on: day(category.assignedAt),
		does_not_assert: [...CATALOG.commonDoesNotCheck, ...definition.doesNotCheck, ...ATTESTATION_LIMITS],
		holder_commitment: input.holderCommitment,
		issued_on: day(input.issuedAt),
		issuer: { platform: input.issuer, signing_key_id: input.signingKeyId }
	};
}

/** The statement as signed; members of later versions are kept as they are. */
export const attestationStatementSchema = z
	.object({
		attestation_version: z.int(),
		subject: z.literal('category'),
		specialization: z.string().describe('Специализация категории'),
		grade: z.string().describe('Грейд категории'),
		confirmed_blocks: z
			.array(z.object({ code: z.string(), title: z.string() }))
			.describe('Определяющие блоки грейда, которые подтвердил тест'),
		confirmed_skill_keys: z.array(z.string()).describe('Подтверждённый стек: ключи навыков справочника'),
		catalog_version: z.string().describe('Версия справочника категорий'),
		bank_release_id: z.string().describe('Выпуск банка заданий, на котором принято решение'),
		decided_on: z.string().describe('День решения теста'),
		does_not_assert: z.array(z.string()).describe('Что подтверждение не подтверждает'),
		holder_commitment: z
			.string()
			.describe('SHA-256 от ФИО владельца и секретной соли: само ФИО по нему не восстановить'),
		issued_on: z.string(),
		issuer: z.object({ platform: z.string(), signing_key_id: z.string() })
	})
	.catchall(z.unknown())
	.describe('Заявление, как оно подписано');

export type AttestationStatement = z.output<typeof attestationStatementSchema>;

/** The words of a specialization and a grade of the catalog; a key the current catalog lacks stays as it is. */
export function categoryTitle(specialization: string, grade: string): { specialization: string; grade: string } {
	return {
		specialization:
			CATALOG.specializations.find((item) => item.key === (specialization as SpecializationKey))?.title ??
			specialization,
		grade: CATALOG.grades.find((item) => item.key === (grade as GradeKey))?.title ?? grade
	};
}
