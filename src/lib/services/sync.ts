import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord, type LocalLine } from '$lib/db/indexeddb';
import {
	metadata,
	getServerMetaVersion,
	ensureMetaVersionRecord,
	META_VERSION_LOCAL_KEY,
	SEED_VERSION_KEY
} from '$lib/state/metadata';
import { CORE_MODULES, DEFAULT_MODULES, seedModule } from '$lib/state/modules';
import { externalizeFilesInObject } from '$lib/services/files';
import { auth } from '$lib/state/auth.svelte';

// Ключ в localStorage: максимальная серверная updated_at из последнего pull.
// Не зависит от локальных записей, поэтому сиды/история не могут сдвинуть
// границу загрузки (иначе после полного обновления пропадали бы старые записи).
const SYNC_ANCHOR_KEY = 'erp_last_pull_anchor';

// Все ключи приложения в localStorage: сбрасываются кнопкой «Полное обновление».
// Не трогаем только сессию Supabase (supabase.auth.token) — иначе после обновления
// придётся логиниться заново.
const APP_STORAGE_KEYS = [
	SYNC_ANCHOR_KEY,
	META_VERSION_LOCAL_KEY,
	SEED_VERSION_KEY,
	'sidebarExpandedGroups'
];

// Удалить ключи приложения из localStorage (для кнопки «Полное обновление»).
export function clearAppStorage(): void {
	if (typeof localStorage === 'undefined') return;
	for (const key of APP_STORAGE_KEYS) localStorage.removeItem(key);
}

export const syncService = {
	// 1. Инициализация и скачивание метаданных (конфигурации системы)
	async pullMetadata() {
		try {
			// Версия метаданных: если на сервере она совпадает с локальной и
			// локальный кэш непуст — конфигурация не менялась, перекачивать нечего.
			const cachedVersion =
				typeof localStorage !== 'undefined' ? localStorage.getItem(META_VERSION_LOCAL_KEY) : null;
			const serverVersion = await getServerMetaVersion();
			if (
				cachedVersion &&
				serverVersion &&
				cachedVersion === serverVersion &&
				(await db.meta_tables.count()) > 0
			) {
				console.log(' Метаданные не менялись, перекачку пропускаем.');
				return;
			}

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

			// Очищаем локальный кэш конфигурации и записываем свежие данные одной транзакцией
			await db.transaction('rw', [db.meta_tables, db.meta_columns], async () => {
				await db.meta_tables.clear();
				await db.meta_columns.clear();

				if (uniqueTables) await db.meta_tables.bulkPut(uniqueTables);
				if (columns) await db.meta_columns.bulkPut(columns);
			});

			console.log(' Метаданные (1С-конфигурация) успешно синхронизированы.');

			// Фиксируем версию: если записи на сервере ещё нет — создаём её,
			// чтобы следующий цикл мог пропустить перекачку.
			if (typeof localStorage !== 'undefined') {
				const finalVersion = serverVersion ?? (await ensureMetaVersionRecord());
				if (finalVersion) localStorage.setItem(META_VERSION_LOCAL_KEY, finalVersion);
			}
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

			// Запрашиваем с сервера записи, измененные после нашей последней синхронизации.
			// Пагинация (сервер отдаёт максимум 1000 строк за запрос): идём смещением от
			// якоря, поэтому записи с одинаковым updated_at на границе батча не теряются
			// (в отличие от продвижения якоря внутри цикла). Проекция колонок не тянет лишнего.
			let offset = 0;
			let page: any[] = [];
			const serverRecords: any[] = [];
			do {
				const { data, error } = await supabase
					.from('data_records')
					.select('id,table_id,status,updated_at,data,is_folder,parent_id')
					.gt('updated_at', lastSyncTime)
					.order('updated_at', { ascending: true })
					.range(offset, offset + 999);
				if (error) throw error;
				page = data ?? [];
				serverRecords.push(...page);
				offset += page.length;
			} while (page.length === 1000);

			// Продвигаем якорь на максимальную из увиденных серверных меток (нормализуем
			// к Z), чтобы следующий цикл не скачивал их заново.
			if (serverRecords.length > 0) {
				let maxSeen = lastSyncTime;
				for (const r of serverRecords) {
					const iso = new Date(r.updated_at).toISOString();
					if (iso > maxSeen) maxSeen = iso;
				}
				localStorage.setItem(SYNC_ANCHOR_KEY, maxSeen);
			}

			if (serverRecords.length === 0) return;

			// Локально изменённые, но ещё не отправленные на сервер записи не затираем:
			// их отправит pushLocalChanges, а серверная копия может быть устаревшей.
			const dirtyIds = new Set(
				(await db.data_records.where('is_dirty').equals(1).toArray()).map((r) => r.id)
			);
			const freshRecords = serverRecords.filter((r) => !dirtyIds.has(r.id));
			if (freshRecords.length === 0) return;

			// Дедуп: записи, которые мы уже скачали с той же меткой времени (например,
			// только что отправленные pushLocalChanges — серверная updated_at совпадает
			// с локальной), не перезаписываем — экономим запись и строки ТЧ.
			const freshIds = freshRecords.map((r) => r.id);
			const existing = await db.data_records.bulkGet(freshIds);
			const existingTime = new Map(
				existing
					.filter((r): r is NonNullable<typeof r> => !!r)
					.map((r) => [r.id, new Date(r.updated_at).getTime()])
			);
			const recordsToWrite = freshRecords.filter((r) => {
				const t = existingTime.get(r.id);
				return t === undefined || t !== new Date(r.updated_at).getTime();
			});
			if (recordsToWrite.length === 0) return;

			// Вложения (data_files) для выносимых записей: копируем в локальное
			// хранилище. Ссылки в jsonb остаются ссылками — содержимое читается
			// on-demand (FileField/код действий гидратируют по fileId).
			const writeIds = new Set(recordsToWrite.map((r) => r.id));
			const serverLines: any[] = [];
			const fileRows: any[] = [];
			const writeIdArr = recordsToWrite.map((r) => r.id);
			const hasFileRefs = recordsToWrite.some((r) =>
				Object.values((r.data as Record<string, any>) ?? {}).some(
					(v: any) => v && typeof v === 'object' && typeof v.fileId === 'string'
				)
			);
			for (let i = 0; i < writeIdArr.length; i += 200) {
				const chunk = writeIdArr.slice(i, i + 200);
				const [{ data: linesData, error: lError }, filesResp] = await Promise.all([
					supabase.from('data_lines').select('*').in('record_id', chunk),
					hasFileRefs
						? supabase.from('data_files').select('*').in('record_id', chunk)
						: Promise.resolve({ data: [] as any[], error: null })
				]);
				if (lError) throw lError;
				serverLines.push(...(linesData ?? []).filter((l) => writeIds.has(l.record_id)));
				if (filesResp.error) throw filesResp.error;
				fileRows.push(...(filesResp.data ?? []));
			}

			// Записываем в IndexedDB
			await db.transaction('rw', [db.data_records, db.data_lines, db.data_files], async () => {
				for (const record of recordsToWrite) {
					await db.data_records.put({
						id: record.id,
						table_id: record.table_id,
						status: record.status,
						data: record.data ?? {},
						updated_at: record.updated_at,
						is_dirty: 0, // Данные пришли с сервера, они "чистые"
						is_folder: record.is_folder ?? false,
						parent_id: record.parent_id ?? null
					});
				}

				for (const line of serverLines) {
					await db.data_lines.put({
						id: line.id,
						record_id: line.record_id,
						table_id: line.table_id,
						data: line.data,
						sort_order: line.sort_order
					});
				}

				// Зеркало вложений: переписываем файлы выносимых записей.
				if (writeIdArr.length > 0) {
					await db.data_files.where('record_id').anyOf(writeIdArr).delete();
					for (const f of fileRows) {
						await db.data_files.put({
							id: f.id,
							record_id: f.record_id,
							column_id: f.column_id,
							name: f.name,
							size: f.size,
							type: f.type,
							content: f.content,
							updated_at: f.updated_at
						});
					}
				}
			});
			console.log(` Синхронизировано ${recordsToWrite.length} записей с сервера.`);
		} catch (err) {
			console.error('Ошибка при скачивании изменений:', err);
		}
	},

	// 3. Отправка локальных изменений на сервер (Пакетный Push)
	async pushLocalChanges() {
		try {
			// Ищем все записи, измененные или созданные пользователем в офлайне
			const dirtyRecords = await db.data_records.where('is_dirty').equals(1).toArray();
			if (dirtyRecords.length === 0) return;

			// Записи независимы — отправляем параллельно (быстрее, чем по очереди).
			// Дубликаты по id не проверяем: id — первичный ключ (миграция 0005),
			// upsert по нему безопасен и не плодит строки.
			const results = await Promise.all(
				dirtyRecords.map(async (localRecord): Promise<{ id: string; ok: boolean }> => {
					try {
						// Извлекаем связанные строки табличной части для текущего документа
						const localLines = await db.data_lines
							.where('record_id')
							.equals(localRecord.id)
							.toArray();

						// 1. Отправляем шапку документа/справочника (используем upsert).
						// Вложения в record.data хранятся ссылками; inline-значения
						// (если остались локально) перед отправкой выносим в хранилище.
						const serverData = await externalizeFilesInObject(
							localRecord.data ?? {},
							localRecord.id
						);
						const { error: rError } = await supabase.from('data_records').upsert({
							id: localRecord.id,
							table_id: localRecord.table_id,
							status: localRecord.status,
							data: serverData,
							updated_at: new Date().toISOString(), // Сервер обновит метку времени
							is_folder: localRecord.is_folder ?? false,
							parent_id: localRecord.parent_id ?? null
						});

						if (rError) throw rError;

						// 1a. Вынесенные файлы из локального хранилища: удаляем старые
						// строки и пишем новые (как ТЧ).
						const files = await db.data_files.where('record_id').equals(localRecord.id).toArray();
						if (files.length > 0) {
							await supabase.from('data_files').delete().eq('record_id', localRecord.id);
							const { error: fError } = await supabase.from('data_files').upsert(
								files.map((f) => ({
									id: f.id,
									record_id: f.record_id,
									column_id: f.column_id,
									name: f.name,
									size: f.size,
									type: f.type,
									content: f.content,
									updated_at: f.updated_at ?? new Date().toISOString()
								}))
							);
							if (fError) throw fError;
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
						return { id: localRecord.id, ok: true };
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
							return { id: localRecord.id, ok: true };
						}
						console.error(`Ошибка отправки записи ${localRecord.id}:`, err);
						return { id: localRecord.id, ok: false };
					}
				})
			);

			const sent = results.filter((r) => r.ok).length;
			if (sent > 0) {
				console.log(` Успешно отправлено на сервер ${sent} изменений.`);
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

		if (auth.status === 'loading') return;

		running = true;
		console.log('Запуск процесса синхронизации...');
		try {
			// Системные таблицы (например, «История») должны существовать до
			// загрузки метаданных, иначе pullMetadata их сотрёт.
			await metadata.ensureSystemTables();
			await this.pullMetadata(); // Сначала конфигурация
			await this.pushLocalChanges(); // Затем отдаем свои изменения
			// Сменился пользователь/права? Чистим кэш и перекачиваем под новыми
			// правами (RLS отдаст только доступное текущему пользователю).
			await auth.ensureDataCacheScope();
			await this.pullDataChanges(); // В конце забираем чужие изменения
			// Сиды справочников — только после загрузки данных, иначе их свежие
			// updated_at сдвинут вотермарк pullDataChanges и серверные записи не
			// попадут в кэш. Опциональные модули (банк, api-запросы и т.д.)
			// сидятся при своей установке, boot их не трогает.
			for (const mod of [...CORE_MODULES, ...DEFAULT_MODULES]) {
				await seedModule(mod);
			}
			// Серверная история не должна расти бесконечно (локально она и так
			// ограничена 50 записями) — чистим старые записи.
			await capServerHistory();
			// Эффективные права для UI (скрытие таблиц, readOnly) — после синка.
			await auth.recomputeAccess();
			console.log('Синхронизация завершена.');
		} finally {
			running = false;
		}
	}
};

// Флаг выполнения синхронизации (защита от одновременного запуска по таймеру и вручную)
let running = false;

// Ограничение глубины «Истории» на сервере (локальный кэш и так ограничен 50).
// Чистим записи старше последних MAX_HISTORY по updated_at батчами по 500.
const MAX_SERVER_HISTORY = 200;

async function capServerHistory() {
	try {
		const { data: historyRow } = await supabase
			.from('meta_tables')
			.select('id')
			.eq('name', 'history')
			.order('id', { ascending: true })
			.limit(1);
		const historyId = historyRow?.[0]?.id;
		if (!historyId) return;

		const { count } = await supabase
			.from('data_records')
			.select('id', { count: 'exact', head: true })
			.eq('table_id', historyId);
		if ((count ?? 0) <= MAX_SERVER_HISTORY) return;

		// Самые свежие MAX_SERVER_HISTORY оставляем, остальное удаляем.
		// range(from, to) — включительно; сервер отдаёт максимум 1000 строк за
		// запрос, поэтому за один цикл чистится до ~1000 записей (для большого
		// хвоста повторится в следующих циклах).
		const { data: stale } = await supabase
			.from('data_records')
			.select('id')
			.eq('table_id', historyId)
			.order('updated_at', { ascending: false })
			.range(MAX_SERVER_HISTORY, MAX_SERVER_HISTORY + 1000);
		const staleIds = (stale ?? []).map((r: { id: string }) => r.id);
		if (staleIds.length === 0) return;
		for (let i = 0; i < staleIds.length; i += 500) {
			await supabase
				.from('data_records')
				.delete()
				.in('id', staleIds.slice(i, i + 500));
		}
	} catch {
		// не критично — почистится при следующем цикле
	}
}
