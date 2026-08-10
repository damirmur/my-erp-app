import { db, type LocalRecord } from '$lib/db/indexeddb';
import { FLOW_TABLE } from '$lib/state/flows';
import { flowExecute, type FlowStep } from '$lib/services/flowRunner';
import { workspace } from '$lib/state/workspace.svelte';
import { buildRecordUrl } from '$lib/services/deeplink';
import type { ApiCommandResult } from '$lib/services/apiCommand';

// Сценарии-триггеры (по-событию). Сценарий (запись таблицы 'flow') сам объявляет,
// на какое событие какой таблицы срабатывает: колонки flow_scenarios
// «Срабатывает для таблицы» (trigger_table, ссылка на таблицу верхнего уровня)
// и «Событие» (trigger_event: save/post/unpost/delete). Движок не знает ни про
// одну конкретную таблицу — привязка целиком в данных.
//
// Запуск — синхронно (вызывающий ждёт), после коммита сохранения: запись
// сохраняется независимо от сценария, сценарий лишь дополняет её (ТЧ/реквизиты).
// Каждый прогон пишется в «Историю» (успех и ошибка одинаково); ошибка
// возвращается вызывающему для показа во всплывающем окне.

export type TriggerEvent = 'save' | 'post' | 'unpost' | 'delete';

export const TRIGGER_EVENT_LABELS: Record<TriggerEvent, string> = {
	save: 'при сохранении',
	post: 'при проведении',
	unpost: 'при отмене проведения',
	delete: 'при удалении'
};

// Глубина вложенности сценариев-триггеров. Сохранения, сделанные внутри
// сценария-триггера (saveRecordWithLines/flow-create), не должны снова
// запускать триггеры — защита от зацикливания и повторного импорта.
let triggerDepth = 0;

// Активен ли сейчас прогон сценария-триггера (внутренние сохранения пишут
// меньше журнала и не запускают триггеры повторно).
export function isTriggerActive(): boolean {
	return triggerDepth > 0;
}

// Перевод перехода статусов в событие триггера. Для новой записи prev === null.
export function transitionEvent(
	prevStatus: string | null | undefined,
	nextStatus: string
): TriggerEvent | null {
	const prev = prevStatus ?? null;
	if (nextStatus === 'posted' && prev !== 'posted') return 'post';
	if (nextStatus === 'draft' && prev === 'posted') return 'unpost';
	if (nextStatus === 'marked_for_deletion' && prev !== 'marked_for_deletion') return 'delete';
	if (nextStatus === 'draft' || nextStatus === 'posted') return 'save';
	return null;
}

// Результат запуска триггеров: что запускалось и не упал ли хоть один сценарий.
export interface TriggerRunResult {
	ran: boolean;
	ok: boolean;
	error?: string;
	count: number;
}

async function findTriggerScenarios(tableId: string, event: TriggerEvent): Promise<LocalRecord[]> {
	const scenarioTable = await db.meta_tables.where('name').equals(FLOW_TABLE).first();
	if (!scenarioTable) return [];
	const scenarios = await db.data_records.where('table_id').equals(scenarioTable.id).toArray();
	return scenarios.filter((s) => {
		const d = s.data ?? {};
		return String(d.trigger_table ?? '') === tableId && d.trigger_event === event;
	});
}

// Прогон одного сценария-триггера. Параметры сценария (доступны коду узла через
// params): recordId (конкретная запись), record (снимок данных), event,
// prevStatus/nextStatus. Результат (успех или ошибка) всегда пишется в историю.
async function runTriggerScenario(
	scenario: LocalRecord,
	recordId: string,
	event: TriggerEvent,
	prevStatus: string | null,
	nextStatus: string,
	extra: Record<string, any>
): Promise<void> {
	const current = await db.data_records.get(recordId);
	const params: Record<string, any> = {
		recordId,
		record: current?.data ?? extra.recordSnapshot ?? null,
		event,
		prevStatus: prevStatus ?? null,
		nextStatus
	};
	const title = String(scenario.data?.name ?? 'Сценарий');
	const makeResult = (
		ok: boolean,
		value?: unknown,
		error?: string,
		steps?: FlowStep[]
	): ApiCommandResult => ({
		href: buildRecordUrl(scenario.id),
		label: `${title} · триггер ${TRIGGER_EVENT_LABELS[event]}`,
		ok,
		value: ok ? value : undefined,
		error,
		steps,
		executedAt: new Date().toISOString(),
		flow: { recordId: scenario.id, title }
	});

	try {
		const run = await flowExecute(scenario.id, params);
		await workspace.recordFlowRun(makeResult(true, run.last ?? run.results, undefined, run.steps));
	} catch (e: any) {
		const steps = (e?.steps as FlowStep[] | undefined) ?? [];
		const message = e?.message ?? String(e);
		await workspace.recordFlowRun(makeResult(false, undefined, message, steps));
		throw e;
	}
}

// Запустить все сценарии-триггеры таблицы по переходу статусов prevStatus →
// nextStatus. Синхронно (вызывающий ждёт завершения), но никогда не бросает:
// ошибки сценариев фиксируются в истории и возвращаются в поле error.
// extra.recordSnapshot — снимок данных записи для событий «удаление» (записи
// уже нет в кэше) — передаётся сценарию как params.record.
export async function fireTriggers(
	tableId: string,
	recordId: string,
	prevStatus: string | null | undefined,
	nextStatus: string,
	extra: Record<string, any> = {}
): Promise<TriggerRunResult> {
	const event = transitionEvent(prevStatus, nextStatus);
	if (!event) return { ran: false, ok: true, count: 0 };
	if (triggerDepth > 0) return { ran: false, ok: true, count: 0 };

	const scenarios = await findTriggerScenarios(tableId, event);
	if (scenarios.length === 0) return { ran: false, ok: true, count: 0 };

	const { recordSnapshot, ...scenarioExtra } = extra;
	triggerDepth++;
	try {
		let firstError: string | undefined;
		for (const scenario of scenarios) {
			try {
				await runTriggerScenario(scenario, recordId, event, prevStatus ?? null, nextStatus, {
					...scenarioExtra,
					recordSnapshot
				});
			} catch (e: any) {
				firstError ??= e?.message ?? String(e);
			}
		}
		return { ran: true, ok: firstError === undefined, error: firstError, count: scenarios.length };
	} finally {
		triggerDepth--;
	}
}
