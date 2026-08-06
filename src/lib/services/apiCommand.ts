import { db } from '$lib/db/indexeddb';
import {
	buildExecuteUrl,
	buildListJsonUrl,
	buildRecordJsonUrl,
	resolveLink,
	type DeepLink,
	type ResolvedLink
} from '$lib/services/deeplink';
import { runRecordAction } from '$lib/services/actionRunner';

// Результат API-команды для панели «API»: либо данные записи/списка как JSON,
// либо результат выполнения кода действия (execute) с входными параметрами.
export interface ApiCommandResult {
	href: string;
	label: string;
	ok: boolean;
	value?: unknown;
	error?: string;
	executedAt: string;
}

// Выполнить API-команду по deep-link вида #/t/{id}.json, #/r/{id}.json,
// #/r/{id}.execute({...}).json. Возвращает null, если объект/таблица не найдены.
export async function runApiCommand(link: DeepLink): Promise<ApiCommandResult | null> {
	const executedAt = new Date().toISOString();
	try {
		if (link.kind === 'execute') {
			const tableTitle = await recordTableTitle(link.recordId);
			const result = await runRecordAction(link.recordId, link.params);
			return {
				href: buildExecuteUrl(link.recordId, link.params),
				label: `${tableTitle ?? 'запись'} · Выполнить API`,
				ok: result.ok,
				value: result.value,
				error: result.error,
				executedAt
			};
		}

		if (link.kind === 'recordJson') {
			const resolved = await resolveLink({ kind: 'record', recordId: link.recordId });
			if (!resolved || resolved.kind !== 'record') return null;
			return {
				href: buildRecordJsonUrl(link.recordId),
				label: `${resolved.table.title} №${recordNumber(resolved.record.data)} · данные (JSON)`,
				ok: true,
				value: serialize(resolved),
				executedAt
			};
		}

		if (link.kind === 'listJson') {
			const resolved = await resolveLink({ kind: 'list', tableId: link.tableId });
			if (!resolved || resolved.kind !== 'list') return null;
			return {
				href: buildListJsonUrl(link.tableId),
				label: `${resolved.table.title} · список (JSON)`,
				ok: true,
				value: serialize(resolved),
				executedAt
			};
		}

		return null;
	} catch (e: any) {
		return {
			href: '',
			label: 'API',
			ok: false,
			error: e?.message ?? String(e),
			executedAt
		};
	}
}

async function recordTableTitle(recordId: string): Promise<string | null> {
	const record = await db.data_records.get(recordId);
	if (!record) return null;
	const table = await db.meta_tables.get(record.table_id);
	return table?.title ?? null;
}

function recordNumber(data: Record<string, any> | undefined): string {
	const num = data?.number || data?.name || '';
	return num ? String(num) : '…';
}

// Приводим разрешённую ссылку к чистому JSON-объекту (без колонок с id и т.п.).
function serialize(resolved: ResolvedLink): unknown {
	const table = { id: resolved.table.id, name: resolved.table.name, title: resolved.table.title };
	const columns = resolved.columns.map((c) => ({ name: c.name, title: c.title, type: c.type }));
	if (resolved.kind === 'record') {
		return { kind: 'record', table, columns, record: resolved.record, lines: resolved.lines };
	}
	if (resolved.kind === 'line') {
		return {
			kind: 'line',
			table,
			columns,
			record: resolved.record,
			lines: resolved.lines,
			line: resolved.line,
			subTable: resolved.subTable
		};
	}
	return { kind: 'list', table, columns, records: resolved.records };
}
