import { supabase } from '$lib/db/supabase';

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
			if (type === 'constant') {
				// Константа: единственное поле value, тип меняется в конструкторе
				await supabase.from('meta_columns').insert([
					{
						table_id: data.id,
						name: 'value',
						title: 'Значение',
						type: 'string',
						sort_order: 1
					}
				]);
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

	// Каскадное удаление таблицы вместе с её табличными частями и реквизитами
	async deleteTableCascade(tableId: string) {
		const { data: subs } = await supabase
			.from('meta_tables')
			.select('id')
			.eq('parent_table_id', tableId);
		const subIds = (subs ?? []).map((s) => s.id);

		for (const sid of subIds) {
			const { error } = await supabase.from('meta_columns').delete().eq('table_id', sid);
			if (error) alert(`Ошибка удаления реквизитов ТЧ: ${error.message}`);
		}
		const { error: colErr } = await supabase.from('meta_columns').delete().eq('table_id', tableId);
		if (colErr) alert(`Ошибка удаления реквизитов: ${colErr.message}`);

		const { error: subErr } = await supabase
			.from('meta_tables')
			.delete()
			.in('id', [...subIds, tableId]);
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
		if (colId === 'new') {
			await supabase.from('meta_columns').insert([{ table_id: tableId, ...columnData }]);
		} else {
			await supabase.from('meta_columns').update(columnData).eq('id', colId);
		}
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
		const { error } = await supabase.from('meta_tables').delete().eq('id', tableId);
		if (error) alert(`Ошибка удаления таблицы: ${error.message}`);
	}

	async deleteColumnsByTable(tableId: string) {
		const { error } = await supabase.from('meta_columns').delete().eq('table_id', tableId);
		if (error) alert(`Ошибка удаления колонок: ${error.message}`);
	}
}

export const metadata = new MetadataManager();
