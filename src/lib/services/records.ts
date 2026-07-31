import { supabase } from '$lib/db/supabase';
import { db } from '$lib/db/indexeddb';

// Физическое удаление записей: на сервере (строки ТЧ + шапки) и в локальном кэше.
// Безвозвратно — вызывать только после подтверждения пользователя.
export async function physicalDeleteRecords(recordIds: string[]): Promise<void> {
	const ids = [...new Set(recordIds.filter(Boolean))];
	if (ids.length === 0) return;

	const { error: lineErr } = await supabase.from('data_lines').delete().in('record_id', ids);
	if (lineErr) throw new Error(`Ошибка удаления строк ТЧ: ${lineErr.message}`);
	const { error: recErr } = await supabase.from('data_records').delete().in('id', ids);
	if (recErr) throw new Error(`Ошибка удаления записей: ${recErr.message}`);

	await db.transaction('rw', [db.data_records, db.data_lines], async () => {
		await db.data_records.bulkDelete(ids);
		await db.data_lines.where('record_id').anyOf(ids).delete();
	});
}
