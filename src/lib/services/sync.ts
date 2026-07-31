import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord, type LocalLine } from '$lib/db/indexeddb';

export const syncService = {
	// 1. Инициализация и скачивание метаданных (конфигурации системы)
	// 1. Инициализация и скачивание метаданных (конфигурации системы и макетов печати)
	async pullMetadata() {
		try {
			// Скачиваем структуру таблиц
			const { data: tables, error: tError } = await supabase.from('meta_tables').select('*');

			if (tError) throw tError;

			// Скачиваем структуру колонок
			const { data: columns, error: cError } = await supabase
				.from('meta_columns')
				.select('*')
				.order('sort_order', { ascending: true });

			if (cError) throw cError;

			// Скачиваем HTML-макеты печатных форм
			const { data: pForms, error: pfError } = await supabase.from('print_forms').select('*');

			if (pfError) throw pfError;

			// Очищаем локальный кэш конфигурации и записываем свежие данные одной транзакцией
			await db.transaction(
				'rw',
				[db.meta_tables, db.meta_columns, db.table('print_forms')],
				async () => {
					await db.meta_tables.clear();
					await db.meta_columns.clear();
					await db.table('print_forms').clear(); // Очищаем старые макеты перед обновлением

					if (tables) await db.meta_tables.bulkPut(tables);
					if (columns) await db.meta_columns.bulkPut(columns);
					if (pForms) await db.table('print_forms').bulkPut(pForms); // Сохраняем новые макеты в IndexedDB
				}
			);

			console.log(' Метаданные (1С-конфигурация) и печатные формы успешно синхронизированы.');
		} catch (err) {
			console.error('Ошибка синхронизации метаданных:', err);
		}
	},

	// 2. Скачивание новых и измененных данных (Шапки и строки документов/справочников)
	async pullDataChanges() {
		try {
			// Находим дату последнего локального изменения, чтобы не качать всю базу заново
			const lastRecord = await db.data_records.orderBy('updated_at').last();
			const lastSyncTime = lastRecord ? lastRecord.updated_at : new Date(0).toISOString();

			// Запрашиваем с сервера записи, измененные после нашей последней синхронизации
			const { data: serverRecords, error: rError } = await supabase
				.from('data_records')
				.select('*')
				.gt('updated_at', lastSyncTime);

			if (rError) throw rError;

			if (serverRecords && serverRecords.length > 0) {
				const recordIds = serverRecords.map((r) => r.id);

				// Скачиваем табличные части для этих записей
				const { data: serverLines, error: lError } = await supabase
					.from('data_lines')
					.select('*')
					.in('record_id', recordIds);

				if (lError) throw lError;

				// Записываем в IndexedDB
				await db.transaction('rw', [db.data_records, db.data_lines], async () => {
					for (const record of serverRecords) {
						await db.data_records.put({
							id: record.id,
							table_id: record.table_id,
							status: record.status,
							data: record.data,
							updated_at: record.updated_at,
							is_dirty: 0, // Данные пришли с сервера, они "чистые"
							is_folder: record.is_folder ?? false,
							parent_id: record.parent_id ?? null
						});
					}

					if (serverLines) {
						for (const line of serverLines) {
							await db.data_lines.put({
								id: line.id,
								record_id: line.record_id,
								table_id: line.table_id,
								data: line.data,
								sort_order: line.sort_order
							});
						}
					}
				});
				console.log(` Синхронизировано ${serverRecords.length} записей с сервера.`);
			}
		} catch (err) {
			console.error('Ошибка при скачивании изменений:', err);
		}
	},

	// 3. Отправка локальных изменений на сервер (Пакетный Push)
	async pushLocalChanges() {
		try {
			// Ищем все записи, измененные или созданные пользователем в офлайне
			const dirtyRecords = await db.data_records.where('is_dirty').equals(1).toArray();

			for (const localRecord of dirtyRecords) {
				// Извлекаем связанные строки табличной части для текущего документа
				const localLines = await db.data_lines.where('record_id').equals(localRecord.id).toArray();

				// 1. Отправляем шапку документа/справочника (используем upsert)
				const { error: rError } = await supabase.from('data_records').upsert({
					id: localRecord.id,
					table_id: localRecord.table_id,
					status: localRecord.status,
					data: localRecord.data,
					updated_at: new Date().toISOString(), // Сервер обновит метку времени
					is_folder: localRecord.is_folder ?? false,
					parent_id: localRecord.parent_id ?? null
				});

				if (rError) throw rError;

				// 2. Синхронизируем табличную часть.
				// Чтобы не усложнять, сначала удалим старые строки этой ТЧ на сервере и запишем новые
				await supabase.from('data_lines').delete().eq('record_id', localRecord.id);

				if (localLines.length > 0) {
					const linesToUpsert = localLines.map((l) => ({
						id: l.id,
						record_id: l.record_id,
						table_id: l.table_id,
						data: l.data,
						sort_order: l.sort_order
					}));

					const { error: lError } = await supabase.from('data_lines').upsert(linesToUpsert);

					if (lError) throw lError;
				}

				// 3. Если все прошло гладко, снимаем флаг "is_dirty" в IndexedDB
				await db.data_records.update(localRecord.id, { is_dirty: 0 });
			}

			if (dirtyRecords.length > 0) {
				console.log(` Успешно отправлено на сервер ${dirtyRecords.length} изменений.`);
			}
		} catch (err) {
			console.error('Ошибка при отправке изменений на сервер:', err);
		}
	},

	// Глобальный запуск полной синхронизации (например, по таймеру или кнопке)
	async runFullSync() {
		if (!navigator.onLine) {
			console.log('Офлайн режим. Синхронизация отложена.');
			return;
		}

		console.log('Запуск процесса синхронизации...');
		await this.pullMetadata(); // Сначала конфигурация
		await this.pushLocalChanges(); // Затем отдаем свои изменения
		await this.pullDataChanges(); // В конце забираем чужие изменения
		console.log('Синхронизация завершена.');
	}
};
