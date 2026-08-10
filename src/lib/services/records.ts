import { supabase } from '$lib/db/supabase';
import { db } from '$lib/db/indexeddb';
import { buildRecordUrl } from '$lib/services/deeplink';
import { workspace } from '$lib/state/workspace.svelte';

// Физическое удаление записей: на сервере (строки ТЧ + шапки) и в локальном кэше.
// Безвозвратно — вызывать только после подтверждения пользователя.
export async function physicalDeleteRecords(recordIds: string[]): Promise<void> {
	const ids = [...new Set(recordIds.filter(Boolean))];
	if (ids.length === 0) return;

	// Данные для журнала «История» берём из локального кэша ДО удаления
	const before = await db.data_records.bulkGet(ids);

	const { error: lineErr } = await supabase.from('data_lines').delete().in('record_id', ids);
	if (lineErr) throw new Error(`Ошибка удаления строк ТЧ: ${lineErr.message}`);
	const { error: recErr } = await supabase.from('data_records').delete().in('id', ids);
	if (recErr) throw new Error(`Ошибка удаления записей: ${recErr.message}`);

	await db.transaction('rw', [db.data_records, db.data_lines], async () => {
		await db.data_records.bulkDelete(ids);
		await db.data_lines.where('record_id').anyOf(ids).delete();
	});

	// Журнал изменений: факт безвозвратного удаления (ссылка на объект уже мертва)
	for (const rec of before) {
		if (!rec) continue;
		try {
			const table = await db.meta_tables.get(rec.table_id);
			if (!table || table.type === 'system') continue;
			const num = rec.data?.number || rec.data?.name || '';
			const title = num ? `${table.title} №${num}` : table.title;
			await workspace.recordHistory(rec.table_id, title, buildRecordUrl(rec.id), 'delete');
		} catch {
			// история — некритично
		}
	}
}

// Полная очистка иерархии таблицы при её отключении (строгий порядок!):
//   1) у всех записей очищается parent_id (группа);
//   2) затем удаляются все записи-папки (is_folder = true).
// Иначе при повторном включении иерархии остались бы «висячие» группы
// и непонятная структура. И сервер, и локальный кэш обновляются сразу.
export async function clearHierarchy(tableId: string): Promise<void> {
	// 1. Очищаем группы: сервер + локально (помечаем is_dirty для отправки при синке)
	const { error: clearErr } = await supabase
		.from('data_records')
		.update({ parent_id: null })
		.eq('table_id', tableId)
		.not('parent_id', 'is', null);
	if (clearErr) throw new Error(`Ошибка очистки групп: ${clearErr.message}`);

	const records = await db.data_records.where('table_id').equals(tableId).toArray();
	await db.data_records.bulkPut(
		records.map((r) => ({
			...r,
			parent_id: null,
			is_dirty: 1,
			updated_at: new Date().toISOString()
		}))
	);

	// 2. Удаляем папки (сервер + локально + строки ТЧ + журнал)
	const folderIds = records.filter((r) => r.is_folder).map((r) => r.id);
	if (folderIds.length > 0) {
		await physicalDeleteRecords(folderIds);
	}
}
