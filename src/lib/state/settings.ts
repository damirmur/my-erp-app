import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord } from '$lib/db/indexeddb';
import { ensureTable } from '$lib/state/seed';

// Модуль настроек приложения: системная таблица app_settings (hiddenInMain).
// Каждая настройка — обычная запись data_records с ключом в data.key (например,
// main_nav_order или translate_service), поэтому синхронизируется между
// устройствами и переживает «Полное обновление».
export const APP_SETTINGS_TABLE = 'app_settings';
export const NAV_ORDER_KEY = 'main_nav_order';
export const TRANSLATE_SERVICE_KEY = 'translate_service';

// Конфиг порядка меню основного режима:
//   typeOrder:  [typeName, ...]            — порядок групп (типов таблиц)
//   tableOrder: { [typeName]: [tableId...] } — порядок таблиц внутри группы
export interface NavOrderConfig {
	typeOrder?: string[];
	tableOrder?: Record<string, string[]>;
}

// Конфиг автоперевода имён полей (синоним → name):
//   serviceId  — запись каталога «Сервисы API» ('' = автоматический сид-переводчик)
//   sourceLang — язык синонима ('' = язык браузера)
//   targetLang — целевой язык name ('' = en)
export interface TranslateConfig {
	serviceId: string;
	sourceLang: string;
	targetLang: string;
}

async function findSettingsTable(): Promise<{ id: string } | null> {
	return (await db.meta_tables.where('name').equals(APP_SETTINGS_TABLE).first()) ?? null;
}

// Запись-настройка в локальном кэше по ключу.
async function findSettingRecord(key: string): Promise<LocalRecord | null> {
	const table = await findSettingsTable();
	if (!table) return null;
	return (
		(await db.data_records.filter((r) => r.table_id === table.id && r.data?.key === key).first()) ??
		null
	);
}

// Запись-настройка на сервере по ключу. Фильтруем в JS, чтобы не зависеть от
// синтаксиса JSONB-фильтров PostgREST (таблица маленькая).
async function serverSettingRecord(tableId: string, key: string): Promise<{ id: string } | null> {
	try {
		const { data } = await supabase
			.from('data_records')
			.select('id, data')
			.eq('table_id', tableId)
			.limit(1000);
		const rec = (data ?? []).find((r: any) => r.data?.key === key);
		return rec ? { id: rec.id } : null;
	} catch {
		return null;
	}
}

// Идемпотентное создание таблицы настроек (Supabase + локальный кэш).
// Вызывается из metadata.ensureSystemTables() — при старте и перед каждым синком.
export async function ensureSettingsTable(): Promise<void> {
	await ensureTable(APP_SETTINGS_TABLE, 'Настройки', 'system', { hiddenInMain: true });
}

// Сохранение настройки: локально (is_dirty=1, уедет обычным синком) и на сервер,
// если онлайн. Идемпотентно — одна запись на ключ.
async function persistSettingRecord(key: string, data: Record<string, any>): Promise<void> {
	const table = await findSettingsTable();
	if (!table) throw new Error('Нет таблицы настроек приложения');

	const online = typeof navigator === 'undefined' || navigator.onLine;
	const now = new Date().toISOString();
	const serverId = online ? ((await serverSettingRecord(table.id, key))?.id ?? null) : null;
	const local = await findSettingRecord(key);

	const record: LocalRecord = {
		id: local?.id ?? serverId ?? crypto.randomUUID(),
		table_id: table.id,
		status: 'draft',
		is_folder: false,
		parent_id: null,
		// Глубокая копия без Svelte $state-прокси: IndexedDB не может
		// структурировано клонировать прокси (DataCloneError).
		data: JSON.parse(JSON.stringify({ key, ...data })),
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

async function deleteSettingRecord(key: string): Promise<void> {
	const table = await findSettingsTable();
	if (!table) return;

	const online = typeof navigator === 'undefined' || navigator.onLine;
	const local = await findSettingRecord(key);
	if (local) await db.data_records.delete(local.id);

	if (online) {
		const serverId = (await serverSettingRecord(table.id, key))?.id;
		if (serverId) {
			try {
				await supabase.from('data_records').delete().eq('id', serverId);
			} catch {
				// повторится при следующем цикле
			}
		}
	}
}

// Конфиг из локального кэша (без сети). Пустые поля — действует порядок по умолчанию.
export async function loadNavOrder(): Promise<NavOrderConfig> {
	const rec = await findSettingRecord(NAV_ORDER_KEY);
	const data = rec?.data ?? {};
	return {
		typeOrder: Array.isArray(data.typeOrder) ? data.typeOrder : undefined,
		tableOrder: data.tableOrder && typeof data.tableOrder === 'object' ? data.tableOrder : undefined
	};
}

export async function saveNavOrder(config: NavOrderConfig): Promise<void> {
	await persistSettingRecord(NAV_ORDER_KEY, config as Record<string, any>);
}

export async function clearNavOrder(): Promise<void> {
	await deleteSettingRecord(NAV_ORDER_KEY);
}

// Конфиг автоперевода: пустые поля означают «по умолчанию»
// (serviceId — сид-переводчик, sourceLang — язык браузера, targetLang — en).
export async function loadTranslateConfig(): Promise<TranslateConfig> {
	const rec = await findSettingRecord(TRANSLATE_SERVICE_KEY);
	const d = rec?.data ?? {};
	return {
		serviceId: typeof d.serviceId === 'string' ? d.serviceId : '',
		sourceLang: typeof d.sourceLang === 'string' ? d.sourceLang : '',
		targetLang: typeof d.targetLang === 'string' ? d.targetLang : ''
	};
}

export async function saveTranslateConfig(config: TranslateConfig): Promise<void> {
	await persistSettingRecord(TRANSLATE_SERVICE_KEY, config as Record<string, any>);
}
