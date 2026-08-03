import { supabase } from '$lib/db/supabase';
import { db } from '$lib/db/indexeddb';
import { getTableType } from '$lib/table-types';

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_|_$/g, '');
	return slug || `tbl_${Date.now().toString(36)}`;
}

class MetadataManager {
	async createNewTable(
		title: string,
		type: string,
		name?: string,
		parentTableId: string | null = null,
		config?: Record<string, any>
	): Promise<string | null> {
		const slug = name || slugify(title);
		const { data, error } = await supabase
			.from('meta_tables')
			.insert([
				{
					name: slug,
					title,
					type,
					parent_table_id: parentTableId,
					config: config ?? {}
				}
			])
			.select()
			.single();

		if (error) {
			alert(`Ошибка: ${error.message}`);
			return null;
		}

		if (data && !parentTableId) {
			const template = getTableType(type).fields ?? [];
			if (template.length > 0) {
				// Поля по шаблону типа (в т.ч. кастомные типы)
				await supabase.from('meta_columns').insert(
					template.map((f, i) => ({
						table_id: data.id,
						name: f.name,
						title: f.title,
						type: f.type,
						sort_order: i + 1
					}))
				);
			} else {
				// Базовые реквизиты создаем только для независимых объектов
				await supabase.from('meta_columns').insert([
					{
						table_id: data.id,
						name: 'number',
						title: type === 'document' ? 'Номер' : 'Код',
						type: 'string',
						sort_order: 1
					},
					{
						table_id: data.id,
						name: 'name',
						title: type === 'document' ? 'Содержание' : 'Наименование',
						type: 'string',
						sort_order: 2
					}
				]);
			}
		}
		return data ? data.id : null;
	}

	// Явное удаление реквизита объекта
	async deleteColumn(columnId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('id', columnId);
		if (error) alert(`Ошибка удаления поля: ${error.message}`);
		else alert('Реквизит успешно удален из метаданных!');
	}

	// Удаление реквизита без всплывающих уведомлений (для пакетного сохранения)
	async deleteColumnQuiet(columnId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('id', columnId);
		if (error) alert(`Ошибка удаления поля: ${error.message}`);
	}

	// Каскадное удаление таблицы вместе с её табличными частями, реквизитами и данными
	async deleteTableCascade(tableId: string) {
		const { data: subs } = await supabase
			.from('meta_tables')
			.select('id')
			.eq('parent_table_id', tableId);
		const subIds = (subs ?? []).map((s) => s.id);
		const allIds = [...subIds, tableId];

		// Данные (записи и табличные части) удаляем до метаданных — из-за внешних ключей,
		// а также из локального кэша, чтобы они не остались is_dirty и не сломали push
		const { error: lineErr } = await supabase.from('data_lines').delete().in('table_id', allIds);
		if (lineErr) alert(`Ошибка удаления строк ТЧ: ${lineErr.message}`);
		const { error: recErr } = await supabase.from('data_records').delete().in('table_id', allIds);
		if (recErr) alert(`Ошибка удаления данных: ${recErr.message}`);
		await db.data_lines.where('table_id').anyOf(allIds).delete();
		await db.data_records.where('table_id').anyOf(allIds).delete();

		for (const sid of subIds) {
			const { error } = await supabase.from('meta_columns').delete().eq('table_id', sid);
			if (error) alert(`Ошибка удаления реквизитов ТЧ: ${error.message}`);
		}
		const { error: colErr } = await supabase.from('meta_columns').delete().eq('table_id', tableId);
		if (colErr) alert(`Ошибка удаления реквизитов: ${colErr.message}`);

		const { error: subErr } = await supabase.from('meta_tables').delete().in('id', allIds);
		if (subErr) alert(`Ошибка удаления таблицы: ${subErr.message}`);
	}

	async saveOrUpdateColumn(
		tableId: string,
		colId: string | 'new',
		columnData: {
			name: string;
			title: string;
			type: string;
			sort_order: number;
			related_table_id?: string | null;
		}
	) {
		let result;
		if (colId === 'new') {
			result = await supabase
				.from('meta_columns')
				.insert([{ table_id: tableId, ...columnData }]);
		} else {
			result = await supabase.from('meta_columns').update(columnData).eq('id', colId);
		}
		if (result.error) alert(`Ошибка сохранения реквизита: ${result.error.message}`);
	}

	async updateTableConfig(tableId: string, config: Record<string, any>): Promise<string | null> {
		const { error } = await supabase.from('meta_tables').update({ config }).eq('id', tableId);
		if (error) {
			alert(`Ошибка сохранения настроек: ${error.message}`);
			return null;
		}
		return tableId;
	}

	// Обновление синонима (заголовка) таблицы
	async updateTableTitle(tableId: string, title: string) {
		const { error } = await supabase.from('meta_tables').update({ title }).eq('id', tableId);
		if (error) alert(`Ошибка сохранения синонима: ${error.message}`);
	}

	async deleteTable(tableId: string) {
		// Удаляем и строки ТЧ таблицы (записей у подтаблиц не бывает),
		// чтобы они не остались в локальном кэше и не сломали push
		const { error: lineErr } = await supabase.from('data_lines').delete().eq('table_id', tableId);
		if (lineErr) alert(`Ошибка удаления строк ТЧ: ${lineErr.message}`);
		await db.data_lines.where('table_id').equals(tableId).delete();
		const { error } = await supabase.from('meta_tables').delete().eq('id', tableId);
		if (error) alert(`Ошибка удаления таблицы: ${error.message}`);
	}

	async deleteColumnsByTable(tableId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('table_id', tableId);
		if (error) alert(`Ошибка удаления колонок: ${error.message}`);
	}
}

export const metadata = new MetadataManager();
