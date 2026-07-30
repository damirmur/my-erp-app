import { supabase } from '$lib/db/supabase';

function slugify(text: string): string {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return slug || `tbl_${Date.now().toString(36)}`;
}

class MetadataManager {
    async createNewTable(title: string, type: string, name?: string, parentTableId: string | null = null, config?: Record<string, any>): Promise<string | null> {
        const slug = name || slugify(title);
        const { data, error } = await supabase
            .from('meta_tables')
            .insert([{ 
                name: slug,
                title, 
                type,
                parent_table_id: parentTableId,
                config: config ?? {}
            }])
            .select()
            .single();

        if (error) {
            alert(`Ошибка: ${error.message}`);
            return null;
        }

        if (data && !parentTableId) {
            // Базовые реквизиты создаем только для независимых объектов
            await supabase.from('meta_columns').insert([
                { table_id: data.id, name: 'number', title: type === 'document' ? 'Номер' : 'Код', type: 'string', sort_order: 1 },
                { table_id: data.id, name: 'name', title: type === 'document' ? 'Содержание' : 'Наименование', type: 'string', sort_order: 2 }
            ]);
        }
        return data ? data.id : null;
    }

    // Явное удаление реквизита объекта
    async deleteColumn(columnId: string) {
        const { error } = await supabase.from('meta_columns').delete().eq('id', columnId);
        if (error) alert(`Ошибка удаления поля: ${error.message}`);
        else alert('Реквизит успешно удален из метаданных!');
    }

    async saveOrUpdateColumn(
        tableId: string, 
        colId: string | 'new', 
		columnData: { name: string; title: string; type: string; sort_order: number; related_table_id?: string | null }
    ) {
        if (colId === 'new') {
            await supabase.from('meta_columns').insert([{ table_id: tableId, ...columnData }]);
        } else {
            await supabase.from('meta_columns').update(columnData).eq('id', colId);
        }
    }
}

export const metadata = new MetadataManager();
