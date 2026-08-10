import Dexie, { type Table } from 'dexie';
import type { TableTypeFeatures } from '$lib/table-types/type';

// crypto.randomUUID доступен только в secure-context (https/localhost). На
// dev-сервере по LAN-IP (http://10.66.66.9:5173) его нет — без фолбэка boot
// падал, и pullMetadata не запускался (после очистки браузера таблицы не
// тянулись). Один раз подменяем на генератор по Math.random, чтобы все
// 40+ мест с randomUUID работали на любом origin.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
	(crypto as any).randomUUID = () =>
		'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
		});
}

// Описываем интерфейсы для типизации TypeScript (на основе нашей SQL-схемы)
export interface TableConfig {
	features?: Partial<TableTypeFeatures>;
	hiddenActions?: string[];
	statusReadOnly?: Record<string, boolean>;
	periodic?: boolean; // для типа constant: периодическое значение
	manyRecords?: boolean; // для типа constant: несколько записей в одной таблице (список констант)
	runCode?: string; // JS-код действия «▶️ Выполнить» (выполняется в браузере)
	hiddenInMain?: boolean; // скрыть таблицу из основного режима
}

export interface LocalTable {
	id: string;
	name?: string;
	title: string;
	type: string;
	parent_table_id?: string | number | null;
	config?: TableConfig;
}

export interface LocalColumn {
	is_visible: boolean;
	id: string;
	table_id: string;
	name: string;
	title: string;
	type:
		| 'string'
		| 'textarea'
		| 'number'
		| 'boolean'
		| 'date'
		| 'datetime'
		| 'birth'
		| 'jsonb'
		| 'link'
		| 'parent_link'
		| 'file'
		| 'zip'
		| 'universal'
		| 'linelink'
		| 'select'
		| 'paramslist';
	related_table_id?: string;
	related_table_name?: string;
	sort_order: number;
}

export interface LocalRecord {
	id: string;
	table_id: string;
	status: 'draft' | 'posted' | 'marked_for_deletion';
	data: Record<string, any>; // JSONB кастомные поля шапки
	is_dirty: number; // Флаг для синхронизации: 1 - изменено локально, 0 - синхронизировано
	updated_at: string;
	is_folder?: boolean;
	parent_id?: string | number | null;
}

export interface LocalLine {
	id: string;
	record_id?: string;
	table_id?: string;
	data: Record<string, any>;
	sort_order: number;
}

// Вложение, вынесенное из record.data (jsonb) в отдельное хранилище.
// В record.data у поля file/zip остаётся ссылка { name, size, type, fileId };
// само содержимое (base64) живёт здесь — синхронизируется отдельными строками.
export interface LocalFile {
	id: string;
	record_id: string;
	column_id: string;
	name: string;
	size: number;
	type: string;
	content: string; // base64
	updated_at?: string;
}

// Инициализируем класс базы данных Dexie
class ErpIndexedDB extends Dexie {
	meta_tables!: Table<LocalTable, string>;
	meta_columns!: Table<LocalColumn, string>;
	data_records!: Table<LocalRecord, string>;
	data_lines!: Table<LocalLine, string>;
	data_files!: Table<LocalFile, string>;

	constructor() {
		super('ErpOfflineCache');

		this.version(3).stores({
			meta_tables: 'id, &name, type',
			meta_columns: 'id, table_id, name',
			data_records: 'id, table_id, status, is_dirty, updated_at',
			data_lines: 'id, record_id, table_id'
		});

		// v4: индексируем parent_id — иерархические запросы (дети группы,
		// защита от циклов при выборе «Группы») без скана всей таблицы.
		this.version(4).stores({
			meta_tables: 'id, &name, type',
			meta_columns: 'id, table_id, name',
			data_records: 'id, table_id, status, is_dirty, updated_at, parent_id',
			data_lines: 'id, record_id, table_id'
		});

		// v5: отдельное хранилище вложений data_files — содержимое file/zip
		// больше не живёт в record.data.jsonb (новые структуры без совместимости).
		this.version(5).stores({
			meta_tables: 'id, &name, type',
			meta_columns: 'id, table_id, name',
			data_records: 'id, table_id, status, is_dirty, updated_at, parent_id',
			data_lines: 'id, record_id, table_id',
			data_files: 'id, record_id, column_id'
		});
	}
}

export const db = new ErpIndexedDB();
