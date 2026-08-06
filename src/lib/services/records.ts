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
