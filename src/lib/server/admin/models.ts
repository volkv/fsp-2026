// Model operations for the administrator: what each operation is configured with (no secrets), its run-time mode, how
// its calls ended over the last day and the latest calls that did not use the model. The switch goes through
// `ModelModes.set`, which journals `ml.mode_changed` together with the change (contracts 3.1).
import { and, desc, gte, inArray, ne, sql } from 'drizzle-orm';
import type { ActionContext } from '$lib/server/companies/context';
import { invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { Config } from '$lib/server/config';
import type { Executor } from '$lib/server/db';
import { mlResults } from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import type { ModelMode, ModelModes } from '$lib/server/ml/modes';
import { MODEL_OPERATIONS, type ModelOperation } from '$lib/server/ml/result';
import { lacksApiKey, RUNTIME_PROFILES } from '$lib/server/ml/runtime';

export interface ModelsDeps {
	db: Executor;
	modes: Pick<ModelModes, 'list' | 'set'>;
	models: Config['models'];
	now: () => Date;
}

/** One setting of an operation as the page shows it: never a key or a secret, only whether one is set. */
export interface SettingLine {
	label: string;
	value: string;
}

type ProcessingMode = (typeof mlResults.$inferSelect)['processingMode'];

export interface OperationState {
	operation: ModelOperation;
	/** `null` — the operation is not configured: the product takes its path without a model whatever the switch says. */
	settings: SettingLine[] | null;
	/** `null` — the mode store cannot be read; the adapter answers `unavailable` and does not guess. */
	mode: ModelMode | null;
	/** What calls get right now; `no_api_key` — an external runtime without its key, the path without a model. */
	effective: 'model' | 'switched_off' | 'not_configured' | 'no_api_key' | 'mode_unknown';
	/** Calls of the last 24 hours by how they were processed. */
	lastDay: Record<ProcessingMode, number>;
}

export interface ModelProblem {
	id: string;
	operation: string;
	processingMode: ProcessingMode;
	/** Adapter error code (`disabled`, `timeout`, …) and its reason, when the envelope has them. */
	code: string | null;
	reason: string | null;
	/** What was processed: the kind of input, never its content. */
	inputType: string | null;
	createdAt: Date;
}

export interface ModelsOverview {
	operations: OperationState[];
	modeStoreReadable: boolean;
	problems: ModelProblem[];
}

const PROBLEMS_SHOWN = 12;

function hostOf(url: string): string {
	return new URL(url).host;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toLocaleString('ru-RU')} с`;
}

function settingsOf(operation: ModelOperation, models: Config['models']): SettingLine[] | null {
	switch (operation) {
		case 'extract': {
			const settings = models.extract;
			if (!settings) return null;
			return [
				{ label: 'Модель', value: settings.model },
				{
					label: 'Профиль',
					value:
						RUNTIME_PROFILES[settings.runtime].hosting === 'external'
							? 'внешняя модель по API — текст уходит провайдеру'
							: 'своя модель платформы'
				},
				{ label: 'Рантайм', value: hostOf(settings.baseUrl) },
				{ label: 'Ключ доступа', value: settings.apiKey ? 'задан' : 'не задан' },
				{ label: 'Срок фонового вызова', value: seconds(settings.timeoutMs) },
				{ label: 'Срок интерактивного вызова', value: seconds(settings.interactiveTimeoutMs) },
				{ label: 'Одновременных запросов', value: String(settings.maxConcurrency) }
			];
		}
		case 'embed': {
			const settings = models.embed;
			if (!settings) return null;
			return [
				{ label: 'Модель', value: settings.model },
				{ label: 'Рантайм', value: hostOf(settings.baseUrl) },
				{ label: 'Ключ доступа', value: settings.apiKey ? 'задан' : 'не задан' },
				{ label: 'Пространство векторов', value: settings.spaceId },
				{ label: 'Срок фонового вызова', value: seconds(settings.timeoutMs) },
				{ label: 'Срок интерактивного вызова', value: seconds(settings.interactiveTimeoutMs) },
				{ label: 'Размер пакета', value: String(settings.batchSize) }
			];
		}
		case 'rerank': {
			const settings = models.rerank;
			if (!settings) return null;
			return [
				{ label: 'Модель', value: settings.model },
				{ label: 'Рантайм', value: hostOf(settings.baseUrl) },
				{ label: 'Ключ доступа', value: settings.apiKey ? 'задан' : 'не задан' },
				{ label: 'Срок фонового вызова', value: seconds(settings.timeoutMs) },
				{ label: 'Срок интерактивного вызова', value: seconds(settings.interactiveTimeoutMs) },
				{ label: 'Кандидатов на переранжирование', value: String(settings.topN) }
			];
		}
	}
}

const emptyDay = (): Record<ProcessingMode, number> => ({ model: 0, rules_only: 0, partial: 0, failed: 0 });

function textField(value: unknown, key: string): string | null {
	if (typeof value !== 'object' || value === null) return null;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === 'string' ? field : null;
}

export async function modelsOverview(deps: ModelsDeps, ctx: ActionContext): Promise<ModelsOverview> {
	requirePermission(ctx.subject, 'policy.manage', null);
	const since = new Date(deps.now().getTime() - 86_400_000);
	const [modes, counts, problems] = await Promise.all([
		deps.modes.list(),
		deps.db
			.select({ operation: mlResults.operation, mode: mlResults.processingMode, n: sql<number>`count(*)::int` })
			.from(mlResults)
			.where(and(gte(mlResults.createdAt, since), inArray(mlResults.operation, [...MODEL_OPERATIONS])))
			.groupBy(mlResults.operation, mlResults.processingMode),
		deps.db
			.select({
				id: mlResults.id,
				operation: mlResults.operation,
				processingMode: mlResults.processingMode,
				failure: mlResults.failure,
				inputRef: mlResults.inputRef,
				createdAt: mlResults.createdAt
			})
			.from(mlResults)
			.where(ne(mlResults.processingMode, 'model'))
			.orderBy(desc(mlResults.createdAt))
			.limit(PROBLEMS_SHOWN)
	]);
	const operations = MODEL_OPERATIONS.map((operation): OperationState => {
		const settings = settingsOf(operation, deps.models);
		const mode = modes.ok ? modes.value[operation] : null;
		const lastDay = emptyDay();
		for (const row of counts) if (row.operation === operation) lastDay[row.mode] = row.n;
		const effective: OperationState['effective'] =
			settings === null
				? 'not_configured'
				: operation === 'extract' && deps.models.extract && lacksApiKey(deps.models.extract)
					? 'no_api_key'
					: mode === null
						? 'mode_unknown'
						: mode === 'off'
							? 'switched_off'
							: 'model';
		return { operation, settings, mode, effective, lastDay };
	});
	return {
		operations,
		modeStoreReadable: modes.ok,
		problems: problems.map((row) => ({
			id: row.id,
			operation: row.operation,
			processingMode: row.processingMode,
			code: textField(row.failure, 'code'),
			reason: textField(row.failure, 'reason'),
			inputType: textField(row.inputRef, 'type'),
			createdAt: row.createdAt
		}))
	};
}

export interface ModeSwitch {
	operation: ModelOperation;
	mode: ModelMode;
}

/** The switch form: the operation and the mode it is set to. */
export function parseModeSwitch(form: FormData): ModeSwitch {
	const operation = MODEL_OPERATIONS.find((value) => value === form.get('operation'));
	const posted = form.get('mode');
	const mode = posted === 'on' || posted === 'off' ? posted : undefined;
	if (operation === undefined || mode === undefined) {
		throw invalid([{ path: 'mode', code: 'invalid', message: 'Выберите операцию и режим' }]);
	}
	return { operation, mode };
}

/**
 * Switches an operation on or off for every process of the application without a restart. The mode is an operating
 * policy of the product, so the administrator's `policy.manage` decides; the switch and its journal entry are one
 * transaction inside `ModelModes.set`.
 */
export async function switchModelMode(
	deps: Pick<ModelsDeps, 'modes'>,
	ctx: ActionContext,
	change: ModeSwitch
): Promise<{ changed: boolean; previous: ModelMode }> {
	requirePermission(ctx.subject, 'policy.manage', null);
	const userId = sessionUserId(ctx.subject);
	try {
		return await deps.modes.set({
			operation: change.operation,
			mode: change.mode,
			actor: { kind: 'user', userId },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent
		});
	} catch (error) {
		// Switched but not journaled and not restored: an inconsistent state that must reach the server errors as is.
		if (error instanceof AggregateError) throw error;
		// `set` leaves the mode as it was when the store or the journal fails: the administrator may simply retry.
		console.error('[admin] model mode switch failed', error);
		throw new ApiError('degraded', {
			message: 'Хранилище режимов или журнал недоступны — режим не изменён, повторите позже',
			cause: error
		});
	}
}
