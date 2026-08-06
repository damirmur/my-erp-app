import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord, type LocalLine } from '$lib/db/indexeddb';
import { metadata } from '$lib/state/metadata';
import { seedNotificationDefaults } from '$lib/state/notifications';
import { seedApiQueryDefaults } from '$lib/state/apiQueries';

// Ключ в localStorage: максимальная серверная updated_at из последнего pull.
// Не зависит от локальных записей, поэтому сиды/история не могут сдвинуть
// границу загрузки (иначе после полного обновления пропадали бы старые записи).
const SYNC_ANCHOR_KEY = 'erp_last_pull_anchor';

export const syncService = {
	// 1. Инициализация и скачивание метаданных (конфигурации системы)
	// 1. Инициализация и скачивание метаданных (конфигурации системы и макетов печати)
	async pullMetadata() {
		try {
			// Скачиваем структуру таблиц
			const { data: tables, error: tError } = await supabase.from('meta_tables').select('*');

			if (tError) throw tError;

			// В IndexedDB на name стоит уникальный индекс, поэтому дубликаты имён
			// (могли остаться на сервере из старых версий) убираем, оставляя первый.
			const seenNames = new Set<string>();
			const uniqueTables = (tables ?? []).filter((t) => {
				const key = t.name ?? t.id;
				if (seenNames.has(key)) return false;
				seenNames.add(key);
				return true;
			});

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

					if (uniqueTables) await db.meta_tables.bulkPut(uniqueTables);
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
			// Якорь последней успешной загрузки хранится в localStorage и НЕ зависит от
			// локальных записей. Если считать его как max(local.updated_at), свежие метки
			// сидов/истории сдвинут границу вперёд — и старые серверные записи (которые
			// локально ещё не скачаны, например после полного обновления) больше не
			// попадут в кэш. Пустой кэш = полная загрузка, якорь сбрасывается.
			const localCount = await db.data_records.count();
			const lastSyncTime =
				localCount === 0
					? new Date(0).toISOString()
					: (localStorage.getItem(SYNC_ANCHOR_KEY) ?? new Date(0).toISOString());

			// Запрашиваем с сервера записи, измененные после нашей последней синхронизации
			const { data: serverRecords, error: rError } = await supabase
				.from('data_records')
				.select('*')
				.gt('updated_at', lastSyncTime);

			if (rError) throw rError;

			// Продвигаем якорь на максимальную из увиденных серверных меток (нормализуем
			// к Z), чтобы следующий цикл не скачивал их заново.
			if (serverRecords && serverRecords.length > 0) {
				const maxSeen = serverRecords.reduce((m, r) => {
					const iso = new Date(r.updated_at).toISOString();
					return iso > m ? iso : m;
				}, lastSyncTime);
				localStorage.setItem(SYNC_ANCHOR_KEY, maxSeen);
			}

			if (serverRecords && serverRecords.length > 0) {
				// Локально изменённые, но ещё не отправленные на сервер записи не затираем:
				// их отправит pushLocalChanges, а серверная копия может быть устаревшей.
				const dirtyIds = new Set(
					(await db.data_records.where('is_dirty').equals(1).toArray()).map((r) => r.id)
				);
				const freshRecords = serverRecords.filter((r) => !dirtyIds.has(r.id));

				if (freshRecords.length === 0) return;

				// Скачиваем табличные части только для действительно новых записей
				const { data: serverLines, error: lError } = await supabase
					.from('data_lines')
					.select('*')
					.in(
						'record_id',
						freshRecords.map((r) => r.id)
					);

				if (lError) throw lError;

				const freshRecordIds = new Set(freshRecords.map((r) => r.id));
				const freshLines = (serverLines ?? []).filter((l) => freshRecordIds.has(l.record_id));

				// Записываем в IndexedDB
				await db.transaction('rw', [db.data_records, db.data_lines], async () => {
					for (const record of freshRecords) {
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

					for (const line of freshLines) {
						await db.data_lines.put({
							id: line.id,
							record_id: line.record_id,
							table_id: line.table_id,
							data: line.data,
							sort_order: line.sort_order
						});
					}
				});
				console.log(` Синхронизировано ${freshRecords.length} записей с сервера.`);
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
				try {
					// Извлекаем связанные строки табличной части для текущего документа
					const localLines = await db.data_lines
						.where('record_id')
						.equals(localRecord.id)
						.toArray();

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

					// Страховка: если в БД нет уникального ограничения на id, upsert вставляет
					// дубликат при каждой отправке. Проверяем и оставляем самую свежую строку.
					const { data: dupCheck, error: dupErr } = await supabase
						.from('data_records')
						.select('id, updated_at')
						.eq('id', localRecord.id);
					if (!dupErr && dupCheck && dupCheck.length > 1) {
						console.warn(
							`Запись ${localRecord.id}: найдено ${dupCheck.length} строк на сервере. Удаляю дубликаты.`
						);
						const newest = [...dupCheck].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
						await supabase
							.from('data_records')
							.delete()
							.eq('id', localRecord.id)
							.neq('updated_at', newest.updated_at);
					}

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
				} catch (err) {
					// 23503 — нарушение внешнего ключа: таблица удалена на сервере,
					// запись никогда не сможет синхронизироваться. Убираем её локально,
					// иначе она будет вечно блокировать отправку других записей.
					if ((err as { code?: string })?.code === '23503') {
						await db.data_records.delete(localRecord.id);
						await db.data_lines.where('record_id').equals(localRecord.id).delete();
						console.warn(
							`Запись ${localRecord.id} удалена локально: её таблица отсутствует на сервере.`
						);
					} else {
						console.error(`Ошибка отправки записи ${localRecord.id}:`, err);
					}
				}
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
		if (running) {
			console.log('Синхронизация уже выполняется, пропускаем запуск.');
			return;
		}

		if (!navigator.onLine) {
			console.log('Офлайн режим. Синхронизация отложена.');
			return;
		}

		running = true;
		console.log('Запуск процесса синхронизации...');
		try {
			// Системные таблицы (например, «История») должны существовать до
			// загрузки метаданных, иначе pullMetadata их сотрёт.
			await metadata.ensureSystemTables();
			await this.pullMetadata(); // Сначала конфигурация
			await this.pushLocalChanges(); // Затем отдаем свои изменения
			await this.pullDataChanges(); // В конце забираем чужие изменения
			// Сиды справочников уведомлений — только после загрузки данных,
			// иначе их свежие updated_at сдвинут вотермарк pullDataChanges и
			// серверные записи (получатели, сообщения) не попадут в кэш.
			await seedNotificationDefaults();
			await seedApiQueryDefaults();
			console.log('Синхронизация завершена.');
		} finally {
			running = false;
		}
	}
};

// Флаг выполнения синхронизации (защита от одновременного запуска по таймеру и вручную)
let running = false;
