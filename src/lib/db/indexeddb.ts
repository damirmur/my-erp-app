import Dexie, { type Table } from 'dexie';
import type { TableTypeFeatures } from '$lib/table-types/type';

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
		| 'universal';
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

export interface PrintForm {
	id: string;
	table_id: string;
	name: string;
	template: string;
	is_default: boolean;
}

// Инициализируем класс базы данных Dexie
class ErpIndexedDB extends Dexie {
	meta_tables!: Table<LocalTable, string>;
	meta_columns!: Table<LocalColumn, string>;
	data_records!: Table<LocalRecord, string>;
	data_lines!: Table<LocalLine, string>;
	print_forms!: Table<PrintForm, string>;

	constructor() {
		super('ErpOfflineCache');

		this.version(3).stores({
			meta_tables: 'id, &name, type',
			meta_columns: 'id, table_id, name',
			data_records: 'id, table_id, status, is_dirty, updated_at',
			data_lines: 'id, record_id, table_id',
			print_forms: 'id, table_id, is_default'
		});
	}
}

export const db = new ErpIndexedDB();
