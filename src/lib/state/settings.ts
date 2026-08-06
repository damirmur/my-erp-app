import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord } from '$lib/db/indexeddb';
import { ensureTable } from '$lib/state/notifications';

// Модуль настроек приложения: системная таблица app_settings (hiddenInMain).
// Сейчас хранит один конфиг — порядок меню основного режима (ключ
// main_nav_order): порядок групп типов (typeOrder) и порядок таблиц внутри
// каждой группы (tableOrder). Таблица создаётся идемпотентно по паттерну
// системной таблицы «История»; сама настройка — обычная запись data_records,
// поэтому синхронизируется между устройствами и переживает «Полное обновление».
export const APP_SETTINGS_TABLE = 'app_settings';
export const NAV_ORDER_KEY = 'main_nav_order';

// Конфиг порядка меню основного режима:
//   typeOrder:  [typeName, ...]            — порядок групп (типов таблиц)
//   tableOrder: { [typeName]: [tableId...] } — порядок таблиц внутри группы
export interface NavOrderConfig {
	typeOrder?: string[];
	tableOrder?: Record<string, string[]>;
}

async function findSettingsTable(): Promise<{ id: string } | null> {
	return (await db.meta_tables.where('name').equals(APP_SETTINGS_TABLE).first()) ?? null;
}

// Запись-конфиг на сервере (по ключу). Фильтруем в JS, чтобы не зависеть от
// синтаксиса JSONB-фильтров PostgREST (таблица маленькая).
async function serverNavRecord(tableId: string): Promise<{ id: string } | null> {
	try {
		const { data } = await supabase
			.from('data_records')
			.select('id, data')
			.eq('table_id', tableId)
			.limit(1000);
		const rec = (data ?? []).find((r: any) => r.data?.key === NAV_ORDER_KEY);
		return rec ? { id: rec.id } : null;
	} catch {
		return null;
	}
}

// Идемпотентное создание таблицы настроек (Supabase + локальный кэш).
// Вызывается из metadata.ensureSystemTables() — при старте и перед каждым синком.
export async function ensureSettingsTable(): Promise<string> {
	return ensureTable(APP_SETTINGS_TABLE, 'Настройки', 'system', { hiddenInMain: true });
}

// Конфиг из локального кэша (без сети). Пустые поля — действует порядок по умолчанию.
export async function loadNavOrder(): Promise<NavOrderConfig> {
	const table = await findSettingsTable();
	if (!table) return {};
	const rec = await db.data_records
		.filter((r) => r.table_id === table.id && r.data?.key === NAV_ORDER_KEY)
		.first();
	const data = rec?.data ?? {};
	return {
		typeOrder: Array.isArray(data.typeOrder) ? data.typeOrder : undefined,
		tableOrder: data.tableOrder && typeof data.tableOrder === 'object' ? data.tableOrder : undefined
	};
}

// Сохранение порядка: пишем локально (is_dirty=1, уедет обычным синком) и на
// сервер, если онлайн. Idempotent — одна запись на ключ.
export async function saveNavOrder(config: NavOrderConfig): Promise<void> {
	const table = await findSettingsTable();
	if (!table) throw new Error('Нет таблицы настроек приложения');

	const online = typeof navigator === 'undefined' || navigator.onLine;
	const now = new Date().toISOString();
	const serverId = online ? ((await serverNavRecord(table.id))?.id ?? null) : null;
	const local = await db.data_records
		.filter((r) => r.table_id === table.id && r.data?.key === NAV_ORDER_KEY)
		.first();

	const record: LocalRecord = {
		id: local?.id ?? serverId ?? crypto.randomUUID(),
		table_id: table.id,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		// Глубокая копия без Svelte $state-прокси: IndexedDB не может
		// структурировано клонировать прокси (DataCloneError).
		data: JSON.parse(JSON.stringify({ key: NAV_ORDER_KEY, ...config })),
		is_dirty: 1,
		updated_at: now
	};

	await db.data_records.put(record);
	if (online) {
		try {
			// Шлём только серверные колонки (как pushLocalChanges): is_dirty в БД нет.
			await supabase.from('data_records').upsert({
				id: record.id,
				table_id: record.table_id,
				status: record.status,
				data: record.data,
				updated_at: record.updated_at,
				is_folder: record.is_folder ?? false,
				parent_id: record.parent_id ?? null
			});
		} catch {
			// сервер недоступен — уедет при ближайшем синке
		}
	}
}

// Сброс порядка к стандартному: удаляем запись локально и на сервере.
export async function clearNavOrder(): Promise<void> {
	const table = await findSettingsTable();
	if (!table) return;

	const online = typeof navigator === 'undefined' || navigator.onLine;
	const local = await db.data_records
		.filter((r) => r.table_id === table.id && r.data?.key === NAV_ORDER_KEY)
		.first();
	if (local) await db.data_records.delete(local.id);

	if (online) {
		const serverId = (await serverNavRecord(table.id))?.id;
		if (serverId) {
			try {
				await supabase.from('data_records').delete().eq('id', serverId);
			} catch {
				// повторится при следующем цикле
			}
		}
	}
}
