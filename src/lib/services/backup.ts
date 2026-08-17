// Выгрузка/загрузка проекта одним JSON-файлом. Срезы всех 6 таблиц Supabase
// (метаданные + данные + вложения) с сохранением uuid — перенос структуры и
// данных между проектами. Источник экспорта — сервер (через supabase-клиент),
// а не локальный Dexie: кэш неполон (история урезана до 50, meta_table_types
// в Dexie не хранится). Импорт — прямая запись в Supabase нового проекта с
// предварительной очисткой таблиц (режим «замена», целевой проект новый).
import { supabase } from '$lib/db/supabase';
import { ALL_MODULES } from '$lib/state/modules';
import { HISTORY_TABLE_NAME } from '$lib/state/metadata';

export interface ProjectBackup {
	format: 'my-erp-app-project';
	version: 1;
	exportedAt: string;
	metaTableTypes: any[];
	metaTables: any[];
	metaColumns: any[];
	dataRecords: any[];
	dataLines: any[];
	dataFiles: any[];
}

export interface ImportReport {
	metaTableTypes: number;
	metaTables: number;
	metaColumns: number;
	dataRecords: number;
	dataLines: number;
	dataFiles: number;
}

export const BACKUP_FORMAT = 'my-erp-app-project';
export const BACKUP_VERSION = 1 as const;

const SERVER_PAGE_SIZE = 1000;

// Имена системных таблиц (сиды): история + все таблицы модулей. При выгрузке
// без системных таблиц эти имена исключаются из metaTables/metaColumns/данных.
export function systemTableNames(): string[] {
	const names = new Set<string>([HISTORY_TABLE_NAME]);
	for (const mod of ALL_MODULES) {
		for (const name of mod.tables) names.add(name);
	}
	return [...names];
}

// Все строки таблицы пагинацией (сервер отдаёт максимум 1000 строк за запрос).
async function fetchAll(table: string): Promise<any[]> {
	const rows: any[] = [];
	let offset = 0;
	for (;;) {
		const { data, error } = await supabase
			.from(table)
			.select('*')
			.order('id', { ascending: true })
			.range(offset, offset + SERVER_PAGE_SIZE - 1);
		if (error) throw new Error(`Ошибка чтения ${table}: ${error.message}`);
		const page = data ?? [];
		rows.push(...page);
		if (page.length < SERVER_PAGE_SIZE) break;
		offset += page.length;
	}
	return rows;
}

// Удалить все строки таблицы на сервере (пагинацией по id).
async function clearTable(table: string): Promise<void> {
	for (;;) {
		const { data, error } = await supabase
			.from(table)
			.select('id')
			.order('id', { ascending: true })
			.range(0, SERVER_PAGE_SIZE - 1);
		if (error) throw new Error(`Ошибка очистки ${table}: ${error.message}`);
		if (!data || data.length === 0) break;
		const { error: delError } = await supabase
			.from(table)
			.delete()
			.in(
				'id',
				data.map((r) => r.id)
			);
		if (delError) throw new Error(`Ошибка очистки ${table}: ${delError.message}`);
		if (data.length < SERVER_PAGE_SIZE) break;
	}
}

// Вставка пагинацией: каждый вызов вставляет по кусочку.
async function insertChunked(table: string, rows: any[]): Promise<void> {
	for (let i = 0; i < rows.length; i += SERVER_PAGE_SIZE) {
		const chunk = rows.slice(i, i + SERVER_PAGE_SIZE);
		const { error } = await supabase.from(table).upsert(chunk);
		if (error) throw new Error(`Ошибка записи ${table}: ${error.message}`);
	}
}

// Полная выгрузка проекта в JSON-объект. includeSystem=false исключает
// системные таблицы (сиды) и их данные — только пользовательская структура.
export async function exportProject(includeSystem = true): Promise<ProjectBackup> {
	const exclude = includeSystem ? new Set<string>() : new Set(systemTableNames());
	const excludedTables = new Set<string>();

	const metaTables = (await fetchAll('meta_tables')).filter((t) => {
		const isSystem = exclude.has(t.name);
		if (isSystem) excludedTables.add(t.id);
		return !isSystem;
	});
	const excludedIds = [...excludedTables];

	const metaColumns = (await fetchAll('meta_columns')).filter(
		(c) => !excludedIds.includes(c.table_id)
	);

	// Исключаем записи системных таблиц и их данные (по table_id родителя).
	const dataRecords = (await fetchAll('data_records')).filter(
		(r) => !excludedIds.includes(r.table_id)
	);
	const keptRecordIds = new Set(dataRecords.map((r) => r.id));
	const dataLines = (await fetchAll('data_lines')).filter(
		(l) => !excludedIds.includes(l.table_id) && keptRecordIds.has(l.record_id)
	);
	const dataFiles = (await fetchAll('data_files')).filter((f) => keptRecordIds.has(f.record_id));

	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		metaTableTypes: await fetchAll('meta_table_types'),
		metaTables,
		metaColumns,
		dataRecords,
		dataLines,
		dataFiles
	};
}

// Загрузка проекта в текущий (новый) проект. Режим «замена»: очищает 6 таблиц
// и пишет данные выгрузки, сохраняя uuid. Порядок очистки обратный зависимостям,
// вставки — прямой (единственный FK: data_files.record_id → data_records).
export async function importProject(backup: ProjectBackup): Promise<ImportReport> {
	if (backup.format !== BACKUP_FORMAT) {
		throw new Error('Неверный формат файла выгрузки.');
	}
	if (backup.version !== BACKUP_VERSION) {
		throw new Error(
			`Несовместимая версия выгрузки: ${backup.version}. Ожидается ${BACKUP_VERSION}.`
		);
	}

	await clearTable('data_files');
	await clearTable('data_lines');
	await clearTable('data_records');
	await clearTable('meta_columns');
	await clearTable('meta_tables');
	await clearTable('meta_table_types');

	await insertChunked('meta_table_types', backup.metaTableTypes ?? []);
	await insertChunked('meta_tables', backup.metaTables ?? []);
	await insertChunked('meta_columns', backup.metaColumns ?? []);
	await insertChunked('data_records', backup.dataRecords ?? []);
	await insertChunked('data_lines', backup.dataLines ?? []);
	await insertChunked('data_files', backup.dataFiles ?? []);

	return {
		metaTableTypes: (backup.metaTableTypes ?? []).length,
		metaTables: (backup.metaTables ?? []).length,
		metaColumns: (backup.metaColumns ?? []).length,
		dataRecords: (backup.dataRecords ?? []).length,
		dataLines: (backup.dataLines ?? []).length,
		dataFiles: (backup.dataFiles ?? []).length
	};
}

// Скачивание выгрузки как файла .json.
export function downloadBackup(backup: ProjectBackup) {
	const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `my-erp-backup-${new Date().toISOString().slice(0, 10)}.json`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Разобрать файл выгрузки в объект.
export async function parseBackupFile(file: File): Promise<ProjectBackup> {
	const text = await file.text();
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('Файл не содержит данных выгрузки.');
	}
	return parsed as ProjectBackup;
}
