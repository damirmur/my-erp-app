import Dexie, { type Table } from 'dexie';

// Описываем интерфейсы для типизации TypeScript (на основе нашей SQL-схемы)
export interface TableConfig {
	features?: {
		hierarchy?: boolean;
		copy?: boolean;
		print?: boolean;
		tabularSections?: boolean;
	};
	hiddenActions?: string[];
	statusReadOnly?: Record<string, boolean>;
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
	type: 'string' | 'number' | 'boolean' | 'date' | 'jsonb' | 'link' | 'parent_link';
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
