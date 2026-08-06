import { supabase } from '$lib/db/supabase';
import { db, type LocalColumn, type LocalRecord } from '$lib/db/indexeddb';

// Модуль уведомлений: каталог «Сервисы API», справочник каналов отправки,
// табличная часть «Контакты» у контрагентов и документ «Сообщение» для
// рассылки через внешний endpoint (например, /api/notify). Таблицы создаются
// идемпотентно (код-сид) при старте приложения и в начале каждого цикла
// синхронизации — по паттерну системной таблицы «История».
//
// Раньше каталог назывался notify_providers — переименован в api_services с
// одноразовой миграцией данных (см. migrateLegacyNotifyProviders). Получатели
// были отдельным справочником notify_recipients с полями tg_id/vk_id/email —
// теперь это подчинённая контрагентам табличная часть «Контакты»
// (contragent_contacts), строка = канал + значение. Старый справочник
// удалён (seed больше не создаёт его).

export const API_SERVICES_TABLE = 'api_services';
export const NOTIFY_CHANNELS_TABLE = 'notify_channels';
export const NOTIFY_MESSAGES_TABLE = 'notify_messages';
export const NOTIFY_MESSAGE_CHANNELS_TABLE = 'notify_message_channels';

// Табличная часть «Контакты» у контрагентов: строки хранятся в data_lines
// (record_id = id контрагента), каждая строка = канал отправки + значение.
export const CONTACT_TABLE = 'contragent_contacts';

const LEGACY_PROVIDERS_TABLE = 'notify_providers';

// Код действия «▶️ Выполнить» документа «Сообщение»: собирает JSON и отправляет
// через apiCall по записи каталога «Сервисы API». Выполняется в браузере
// (runActionCode). Получатели — строки ТЧ «Получатели» документа: Контрагент +
// (необязательно) Канал. Адрес получателя берётся из ТЧ «Контакты» контрагента:
// если в строке задан канал — шлём только в него, если пусто — во все контакты.
// Сервис отправки задаётся в самом канале («Сервис уведомлений»): каналы
// группируются по сервису, на каждый уходит свой запрос.
export const NOTIFY_RUN_CODE = `
// Отправка уведомления через сервис API (apiCall из контекста действия)
const findTableId = async (name) => {
	const t = await db.meta_tables.where('name').equals(name).first();
	if (!t) throw new Error('Нет таблицы ' + name);
	return t.id;
};

const servicesTable = await findTableId('api_services');
const channelsTable = await findTableId('notify_channels');
const contactsTable = await findTableId('contragent_contacts');
const recipientsTabId = await findTableId('notify_message_channels');
const recLines = (lines || []).filter((l) => l.table_id === recipientsTabId);

// 1. Сервис отправки: из поля «Сервис уведомлений» канала (ссылка на api_services).
// Если у канала не задан — первый активный сервис каталога.
const services = await db.data_records.where('table_id').equals(servicesTable).toArray();
const fallbackService = services.find((s) => s.data.is_active !== false) || services[0];

// 2. Контакты контрагентов из ТЧ «Получатели»; группируем по сервису отправки.
const byService = {};
const skipped = [];
for (const line of recLines) {
	const kontragent = line.data.kontragent
		? await db.data_records.get(line.data.kontragent)
		: null;
	if (!kontragent) {
		skipped.push(String(line.data.kontragent || '?'));
		continue;
	}
	const contacts = (await db.data_lines.where('record_id').equals(kontragent.id).toArray()).filter(
		(l) => l.table_id === contactsTable
	);
	// Канал из строки — опционально: задан — только он, пусто — все контакты контрагента
	const selected = line.data.channel
		? contacts.filter((c) => c.data.channel === line.data.channel)
		: contacts;
	for (const contact of selected) {
		const chan = contact.data.channel ? await db.data_records.get(contact.data.channel) : null;
		if (!chan || !chan.data.code || !contact.data.value) {
			skipped.push(chan?.data?.code || String(contact.data.channel || '?'));
			continue;
		}
		const svc = chan.data.service ? await db.data_records.get(chan.data.service) : null;
		const effective = svc || fallbackService;
		if (!effective) {
			skipped.push(chan.data.code);
			continue;
		}
		if (!byService[effective.id]) byService[effective.id] = { service: effective, channels: [] };
		byService[effective.id].channels.push({ type: chan.data.code, id: String(contact.data.value) });
	}
}
const groups = Object.values(byService);
if (groups.length === 0) throw new Error('Нет получателей с заполненными контактами');

// 3. Тело запроса (без channels — они добавляются по каждой группе)
const body = {
	message: String(record.data.message || record.data.subject || '').slice(0, 4000)
};
if (record.data.file && record.data.file.data) {
	body.file = { name: record.data.file.name || 'file', data: record.data.file.data };
}

// 4. Отправка: по одному запросу на сервис через apiCall. Если у сервиса заполнено
// поле-ссылка «Прокси» — запрос идёт через шлюз (внешним API не нужен CORS);
// пусто — прямой fetch из браузера.
const results = [];
for (const g of groups) {
	const res = await apiCall(g.service, {}, { ...body, channels: g.channels });
	results.push({
		service: g.service.data.name || g.service.id,
		ok: res.ok,
		status: res.status,
		response: res.data ?? res.raw
	});
}
log('Ответы серверов:', results);
const allOk = results.every((r) => r.ok);
record.data.last_result = allOk ? 'ok' : 'fail';
record.data.last_response = JSON.stringify(results);
await save(record);
if (!allOk) throw new Error('Ошибка отправки: ' + JSON.stringify(results));
`.trim();

type ColumnSeed = Omit<LocalColumn, 'id' | 'table_id'>;

// Колонки каталога «Сервисы API». Поле-ссылка «Прокси» указывает на другой сервис
// этого же каталога (шлюз): если заполнено — запрос идёт через шлюз, пусто — напрямую.
function serviceColumns(servicesId: string): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'base_url',
			title: 'Базовый URL (${параметр})',
			type: 'string',
			sort_order: 30,
			is_visible: true
		},
		{ name: 'method', title: 'Метод', type: 'string', sort_order: 40, is_visible: false },
		{
			name: 'auth_type',
			title: 'Тип авторизации',
			type: 'string',
			sort_order: 50,
			is_visible: false
		},
		{
			name: 'auth_param',
			title: 'Параметр ключа',
			type: 'string',
			sort_order: 60,
			is_visible: false
		},
		{ name: 'api_key', title: 'Ключ доступа', type: 'string', sort_order: 70, is_visible: false },
		{
			name: 'headers',
			title: 'Заголовки (JSON)',
			type: 'textarea',
			sort_order: 90,
			is_visible: false
		},
		{
			name: 'proxy',
			title: 'Прокси',
			type: 'link',
			sort_order: 100,
			is_visible: false,
			related_table_id: servicesId
		},
		{ name: 'is_active', title: 'Активен', type: 'boolean', sort_order: 110, is_visible: false },
		{
			name: 'description',
			title: 'Описание',
			type: 'textarea',
			sort_order: 120,
			is_visible: true
		}
	];
}

// Колонки каналов отправки. Поле-ссылка «Сервис уведомлений» (на api_services)
// определяет, через какой сервис отправляется канал (например, astro3d-уведомления).
function channelColumns(servicesId: string): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 1, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 2, is_visible: true },
		{ name: 'code', title: 'Код канала', type: 'string', sort_order: 3, is_visible: false },
		{
			name: 'default_recipient',
			title: 'Получатель по умолчанию',
			type: 'string',
			sort_order: 4,
			is_visible: false
		},
		{
			name: 'service',
			title: 'Сервис уведомлений',
			type: 'link',
			sort_order: 5,
			is_visible: true,
			related_table_id: servicesId
		},
		{ name: 'is_active', title: 'Активен', type: 'boolean', sort_order: 6, is_visible: false }
	];
}

// Колонки ТЧ «Контакты» контрагента. Каждая строка — один канал отправки
// (ссылка на «Каналы отправки») и его значение (tg chat id / vk id / e-mail).
function contactColumns(channelsId: string): ColumnSeed[] {
	return [
		{
			name: 'channel',
			title: 'Канал',
			type: 'link',
			sort_order: 1,
			is_visible: true,
			related_table_id: channelsId
		},
		{ name: 'value', title: 'Значение', type: 'string', sort_order: 2, is_visible: true },
		{ name: 'comment', title: 'Комментарий', type: 'string', sort_order: 3, is_visible: true },
		{
			name: 'default',
			title: 'По умолчанию',
			type: 'boolean',
			sort_order: 4,
			is_visible: true
		}
	];
}

function messageColumns(): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Номер', type: 'string', sort_order: 1, is_visible: true },
		{ name: 'date', title: 'Дата', type: 'date', sort_order: 2, is_visible: true },
		{ name: 'subject', title: 'Тема', type: 'string', sort_order: 3, is_visible: true },
		{
			name: 'message',
			title: 'Текст сообщения',
			type: 'textarea',
			sort_order: 4,
			is_visible: true
		},
		{ name: 'file', title: 'Вложение', type: 'file', sort_order: 5, is_visible: false },
		{ name: 'last_result', title: 'Результат', type: 'string', sort_order: 6, is_visible: false },
		{
			name: 'last_response',
			title: 'Ответ сервера',
			type: 'textarea',
			sort_order: 7,
			is_visible: false
		}
	];
}

// Колонки ТЧ «Получатели» документа «Сообщение»: Контрагент + (необязательно)
// Канал. Канал пуст — уходят все контакты контрагента; задан — только он.
function messageRecipientColumns(counterpartiesId: string, channelsId: string): ColumnSeed[] {
	return [
		{
			name: 'kontragent',
			title: 'Контрагент',
			type: 'link',
			sort_order: 1,
			is_visible: true,
			related_table_id: counterpartiesId
		},
		{
			name: 'channel',
			title: 'Канал',
			type: 'link',
			sort_order: 2,
			is_visible: true,
			related_table_id: channelsId
		}
	];
}

// Создать таблицу (Supabase + локальный кэш), если её нет. Возвращает её id.
// Локально приводим к одной канонической строке по name (как «История»),
// чтобы уникальный индекс name в IndexedDB не выдавал ConstraintError.
export async function ensureTable(
	name: string,
	title: string,
	type: string,
	config: Record<string, any>,
	parentTableId: string | null = null
): Promise<string> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	let tableId: string | null = null;
	if (online) {
		try {
			const { data } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', name)
				.order('id', { ascending: true })
				.limit(1);
			tableId = data?.[0]?.id ?? null;
		} catch {
			tableId = null;
		}
	}

	if (!tableId) {
		try {
			const { data, error } = await supabase
				.from('meta_tables')
				.insert([{ name, title, type, parent_table_id: parentTableId, config }])
				.select()
				.single();
			if (!error && data) tableId = data.id;
		} catch {
			tableId = null;
		}
	}

	// Серверные дубликаты имени: переносим их колонки и данные в каноническую
	// таблицу и удаляем, иначе pullMetadata (он очищает локальный кэш и тянет всё
	// с сервера) будет возвращать дубликат в кэш, и у записи появится лишняя
	// пустая табличная часть.
	if (tableId && online) {
		try {
			const { data: allRows } = await supabase.from('meta_tables').select('id').eq('name', name);
			const dups = (allRows ?? []).filter((t) => t.id !== tableId);
			for (const dup of dups) {
				await supabase.from('meta_columns').update({ table_id: tableId }).eq('table_id', dup.id);
				await supabase.from('data_records').update({ table_id: tableId }).eq('table_id', dup.id);
				await supabase.from('data_lines').update({ table_id: tableId }).eq('table_id', dup.id);
				await supabase.from('meta_tables').delete().eq('id', dup.id);
			}
		} catch {
			// сервер недоступен — дубликат уберётся при следующем цикле
		}
	}

	const localRows = await db.meta_tables.where('name').equals(name).toArray();
	const localCanonical = localRows.find((r) => r.id === tableId) ?? localRows[0] ?? null;
	const effectiveId = tableId ?? localCanonical?.id ?? crypto.randomUUID();

	await db.transaction(
		'rw',
		[db.meta_tables, db.meta_columns, db.data_records, db.data_lines],
		async () => {
			for (const row of localRows) {
				if (row.id === effectiveId) continue;
				await db.data_records.where('table_id').equals(row.id).modify({ table_id: effectiveId });
				await db.data_lines.where('table_id').equals(row.id).modify({ table_id: effectiveId });
				await db.meta_columns.where('table_id').equals(row.id).delete();
				await db.meta_tables.delete(row.id);
			}
			await db.meta_tables.put({
				id: effectiveId,
				name,
				title,
				type,
				parent_table_id: parentTableId,
				config
			});
		}
	);

	return effectiveId;
}

// Колонки таблицы: проверяет и создаёт недостающие на сервере (если онлайн)
// и локально. Идемпотентно — добавляются только отсутствующие по name, поэтому
// новые колонки (например, «Прокси») появляются и у уже существующей таблицы.
export async function ensureColumns(
	tableId: string,
	columns: ColumnSeed[],
	online: boolean
): Promise<void> {
	if (online) {
		try {
			const { data: existingCols } = await supabase
				.from('meta_columns')
				.select('name')
				.eq('table_id', tableId);
			const existingNames = new Set((existingCols ?? []).map((c) => c.name));
			const missing = columns.filter((c) => !existingNames.has(c.name));
			if (missing.length > 0) {
				await supabase
					.from('meta_columns')
					.insert(missing.map((c) => ({ table_id: tableId, ...c })));
			}
		} catch {
			// сервер недоступен — достаточно локальной копии
		}
	}

	const localCols = await db.meta_columns.where('table_id').equals(tableId).toArray();
	const localNames = new Set(localCols.map((c) => c.name));
	const missingLocal = columns.filter((c) => !localNames.has(c.name));
	if (missingLocal.length > 0) {
		await db.meta_columns.bulkPut(
			missingLocal.map((c) => ({ id: crypto.randomUUID(), table_id: tableId, ...c }))
		);
	}
}

// Запись в локальный кэш (и на сервер, если онлайн). is_dirty=1 — в ближайшем
// цикле синка запись уедет в Supabase через обычный pushLocalChanges.
export async function seedRecord(record: LocalRecord, online: boolean): Promise<void> {
	await db.data_records.put(record);
	if (online) {
		try {
			await supabase.from('data_records').upsert(record);
		} catch {
			// сервер недоступен — запись уедет при ближайшем синке
		}
	}
}

// Есть ли на сервере записи таблицы. Онлайн-сид сверяется с сервером, чтобы
// после очистки локального кэша не плодить дубликаты каналов/сервисов.
export async function hasServerRows(tableId: string, online: boolean): Promise<boolean> {
	if (!online) return false;
	try {
		const { count } = await supabase
			.from('data_records')
			.select('id', { count: 'exact', head: true })
			.eq('table_id', tableId);
		return (count ?? 0) > 0;
	} catch {
		return false; // сервер недоступен — сидим локально, уедет при ближайшем синке
	}
}

// Есть ли в каталоге «Сервисы API» запись с данным name (на сервере или локально).
// Нужно для досева новых дефолтных сервисов в уже заполненный каталог.
async function serviceExists(servicesId: string, name: string, online: boolean): Promise<boolean> {
	if (online) {
		try {
			const { data } = await supabase
				.from('data_records')
				.select('data')
				.eq('table_id', servicesId)
				.limit(1000);
			if ((data ?? []).some((r: any) => r.data?.name === name)) return true;
		} catch {
			// сервер недоступен — проверяем локальный кэш
		}
	}
	const local = await db.data_records.where('table_id').equals(servicesId).toArray();
	return local.some((r) => r.data?.name === name);
}

// id таблицы по name (сначала сервер, потом локальный кэш). Для «Контрагентов»:
// таблица существует на сервере, но в пустом локальном кэше её ещё может не быть.
export async function findTableIdByName(name: string): Promise<string | null> {
	const online = typeof navigator === 'undefined' || navigator.onLine;
	if (online) {
		try {
			const { data } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', name)
				.order('id', { ascending: true })
				.limit(1);
			if (data?.[0]?.id) return data[0].id;
		} catch {
			// сервер недоступен
		}
	}
	const local = await db.meta_tables.where('name').equals(name).first();
	return local?.id ?? null;
}

// Маппинг данных старой записи notify_providers → api_services.
function migratedServiceData(d: Record<string, any>): Record<string, any> {
	return {
		number: d.number ?? '',
		name: d.name ?? '',
		base_url: d.endpoint ?? d.base_url ?? '',
		method: d.method ?? 'POST',
		auth_type: d.auth_type ?? 'query',
		auth_param: d.auth_param ?? 'notify_key',
		api_key: d.api_key ?? '',
		headers: d.headers ?? '{}',
		use_proxy: d.use_proxy !== undefined ? d.use_proxy : true,
		is_active: d.is_active !== false
	};
}

// Одноразовая миграция notify_providers → api_services (идемпотентна: если
// старой таблицы уже нет ни на сервере, ни локально — делать нечего). Переносит
// записи data_records (id сохраняются, поэтому ссылки в «Сообщении» продолжают
// работать), переводит колонку-ссылку provider на новый id таблицы и удаляет
// старую таблицу вместе с колонками.
async function migrateLegacyNotifyProviders(online: boolean): Promise<void> {
	let legacyServerId: string | null = null;
	if (online) {
		try {
			const { data } = await supabase
				.from('meta_tables')
				.select('id')
				.eq('name', LEGACY_PROVIDERS_TABLE)
				.order('id', { ascending: true })
				.limit(1);
			legacyServerId = data?.[0]?.id ?? null;
		} catch {
			legacyServerId = null;
		}
	}

	const legacyLocal = await db.meta_tables.where('name').equals(LEGACY_PROVIDERS_TABLE).toArray();
	const legacyIds = Array.from(
		new Set([...(legacyServerId ? [legacyServerId] : []), ...legacyLocal.map((r) => r.id)])
	);
	if (legacyIds.length === 0) return;

	const servicesId = (await db.meta_tables.where('name').equals(API_SERVICES_TABLE).first())?.id;
	if (!servicesId) return;

	// 1. Записи data_records: локально — сдвигаем в api_services с новым data.
	for (const legacyId of legacyIds) {
		const legacyRecords = await db.data_records.where('table_id').equals(legacyId).toArray();
		for (const rec of legacyRecords) {
			await db.data_records.put({
				...rec,
				table_id: servicesId,
				data: migratedServiceData(rec.data ?? {}),
				is_dirty: 1,
				updated_at: new Date().toISOString()
			});
		}
	}

	// 2. Колонка-ссылка provider в «Сообщении» теперь указывает на api_services.
	for (const legacyId of legacyIds) {
		await db.meta_columns
			.where('name')
			.equals('provider')
			.modify((col) => {
				if (col.related_table_id === legacyId) col.related_table_id = servicesId;
			});
	}

	// 3. Удаляем старую таблицу локально.
	for (const legacyId of legacyIds) {
		await db.meta_columns.where('table_id').equals(legacyId).delete();
		await db.meta_tables.delete(legacyId);
	}

	// 4. То же на сервере (если он есть).
	if (online && legacyServerId) {
		try {
			const { data: serverRows } = await supabase
				.from('data_records')
				.select('id, data')
				.eq('table_id', legacyServerId);
			for (const row of serverRows ?? []) {
				await supabase
					.from('data_records')
					.update({
						table_id: servicesId,
						data: migratedServiceData(row.data ?? {}),
						updated_at: new Date().toISOString()
					})
					.eq('id', row.id);
			}
			await supabase
				.from('meta_columns')
				.update({ related_table_id: servicesId })
				.eq('name', 'provider')
				.eq('related_table_id', legacyServerId);
			await supabase.from('meta_columns').delete().eq('table_id', legacyServerId);
			await supabase.from('meta_tables').delete().eq('id', legacyServerId);
		} catch {
			// серверная часть повторится при следующем цикле синхронизации
		}
	}

	console.log('Каталог notify_providers переименован в api_services.');
}

// ТЧ «Контакты» у контрагентов: создаёт таблицу (parent = контрагенты) и
// колонки. Идемпотентно; повторные вызовы только добивают недостающее.
async function reconcileContacts(
	counterpartiesId: string,
	channelsId: string,
	online: boolean
): Promise<string> {
	const contactsId = await ensureTable(CONTACT_TABLE, 'Контакты', 'tabular', {}, counterpartiesId);
	await ensureColumns(contactsId, contactColumns(channelsId), online);
	return contactsId;
}

// ТЧ «Получатели» документа «Сообщение»: переименовывает таблицу, приводит
// колонки к [Контрагент, Канал] и удаляет legacy-колонку «Получатель».
async function reconcileMessageTabular(
	tabularId: string,
	counterpartiesId: string | null,
	channelsId: string,
	online: boolean
): Promise<void> {
	if (online) {
		try {
			await supabase.from('meta_tables').update({ title: 'Получатели' }).eq('id', tabularId);
		} catch {
			// повторится при следующем цикле
		}
	}

	// Новые колонки (konтрагент + канал) создаются, только когда известен id контрагентов
	if (counterpartiesId) {
		await ensureColumns(tabularId, messageRecipientColumns(counterpartiesId, channelsId), online);
	}

	// Legacy-колонка «Получатель» (notify_recipients) больше не нужна
	if (online) {
		try {
			const { data: legacyCol } = await supabase
				.from('meta_columns')
				.select('id')
				.eq('table_id', tabularId)
				.eq('name', 'recipient')
				.limit(1);
			if (legacyCol?.[0]?.id) {
				await supabase.from('meta_columns').delete().eq('id', legacyCol[0].id);
			}
		} catch {
			// сервер недоступен
		}
	}
	const localLegacy = await db.meta_columns.where('table_id').equals(tabularId).toArray();
	for (const col of localLegacy) {
		if (col.name === 'recipient') await db.meta_columns.delete(col.id);
	}
}

// Данные по умолчанию: три стандартных канала и каталог сервисов astro3d.ru/api
// (прокси-шлюз, уведомления, астрологические сервисы) + пример wttr.in без прокси
// + геокодинг OpenStreetMap (Nominatim). Сервисы со ссылкой на «Прокси» работают
// через шлюз, wttr.in и Nominatim — напрямую. Пустую таблицу сидим целиком; в уже
// заполненный каталог (существующая установка) недостающие записи досеиваем по
// name (else-ветка). Ключи не сидятся: «Ключ доступа» сервиса-прокси (значение
// NOTIFY_KEY сервера) и «Ключ доступа» уведомлений заполняются в UI. Дефолтные
// получатели — тоже.
async function seedDefaults(
	servicesId: string,
	channelsId: string,
	online: boolean
): Promise<void> {
	// id сервисов генерируем заранее, чтобы каналы и сервисы могли сослаться на них
	const proxyId = crypto.randomUUID();
	const notifyId = crypto.randomUUID();

	const channels = await db.data_records.where('table_id').equals(channelsId).toArray();
	if (channels.length === 0 && !(await hasServerRows(channelsId, online))) {
		const now = new Date().toISOString();
		const rows: LocalRecord[] = [
			{ name: 'Telegram', code: 'tg', service: notifyId, default_recipient: '', is_active: true },
			{ name: 'ВКонтакте', code: 'vk', service: notifyId, default_recipient: '', is_active: true },
			{ name: 'E-mail', code: 'email', service: notifyId, default_recipient: '', is_active: true }
		].map((data, i) => ({
			id: crypto.randomUUID(),
			table_id: channelsId,
			status: 'draft',
			is_folder: false,
			parent_id: null,
			data: { number: String(i + 1), ...data },
			is_dirty: 1,
			updated_at: now
		}));
		for (const row of rows) await seedRecord(row, online);
	}

	const services = await db.data_records.where('table_id').equals(servicesId).toArray();
	const now = new Date().toISOString();
	const defs: { id?: string; data: Record<string, any> }[] = [
		{
			id: proxyId,
			data: {
				number: '1',
				name: 'astro3d — прокси (шлюз)',
				base_url: 'https://astro3d.ru/api/proxy',
				method: 'POST',
				auth_type: 'query',
				auth_param: 'notify_key',
				api_key: '',
				headers: '{}',
				proxy: '',
				is_active: true,
				description:
					'Шлюз для внешних HTTP-API. Укажите его в поле «Прокси» другого сервиса, и запрос уйдёт с сервера astro3d.ru на нужный url — внешнему API не нужен CORS. Тело запроса к шлюзу: { notify_key, url, method, query, headers, body }. Авторизация — ключ доступа этого сервиса (заполните «Ключ доступа» значением NOTIFY_KEY сервера).'
			}
		},
		{
			id: notifyId,
			data: {
				number: '2',
				name: 'astro3d — уведомления',
				base_url: 'https://astro3d.ru/api/notify',
				method: 'POST',
				auth_type: 'query',
				auth_param: 'notify_key',
				api_key: '',
				headers: '{}',
				proxy: proxyId,
				is_active: true,
				description:
					'Рассылка сообщений в Telegram, ВКонтакте и на E-mail. Вызывается автоматически действием «Выполнить» документа «Сообщение»: канал указывает на этот сервис в поле «Сервис уведомлений». Формат: POST JSON { message, channels: [{ type: "tg"|"vk"|"email", id }], file? }. Ключ доступа — notify_key шлюза (заполните в «Ключ доступа»). Идёт через прокси (поле «Прокси»).'
			}
		},
		{
			data: {
				number: '3',
				name: 'wttr.in — погода',
				base_url: 'https://wttr.in/${city}?format=j1&lang=ru',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: '',
				is_active: false,
				description:
					'Пример внешнего API без прокси (поле «Прокси» пустое — запрос идёт напрямую из браузера). Погода по городу через шаблон ${city}. Пример: apiCall(svc, { city: "Moscow" }).'
			}
		},
		{
			data: {
				number: '4',
				name: 'astro3d — натальная карта',
				base_url: 'https://astro3d.ru/api/v1/natal?city=${city}&date=${date}&time=${time}',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: proxyId,
				is_active: false,
				description:
					'Расчёт натальной карты. Параметры (в шаблоне url): city — город, date — YYYY-MM-DD, time — HH:MM (по умолчанию 12:00); hsys — система домов (по умолчанию P). Вместо city можно передать lat и lon. Ответ: JSON { meta, planets, houses, aspects }. Пример: apiCall(svc, { city: "Москва", date: "1990-05-15", time: "14:30" }).'
			}
		},
		{
			data: {
				number: '5',
				name: 'astro3d — синастрия',
				base_url:
					'https://astro3d.ru/api/v1/synastry?city1=${city1}&date1=${date1}&time1=${time1}&city2=${city2}&date2=${date2}&time2=${time2}',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: proxyId,
				is_active: false,
				description:
					'Совместимость двух натальных карт. Параметры: city1, date1, time1 — первый человек, city2, date2, time2 — второй (даты YYYY-MM-DD, время HH:MM); hsys — система домов. Пример: apiCall(svc, { city1: "Москва", date1: "1990-05-15", time1: "12:00", city2: "Санкт-Петербург", date2: "1992-11-03", time2: "08:30" }).'
			}
		},
		{
			data: {
				number: '6',
				name: 'astro3d — периоды',
				base_url:
					'https://astro3d.ru/api/v1/period?start=${start}&end=${end}&step=${step}&city=${city}',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: proxyId,
				is_active: false,
				description:
					'Расчёт астрологических периодов на интервале. Параметры: start и end — YYYY-MM-DD HH:MM (обязательны), step — шаг, city — город. Пример: apiCall(svc, { start: "2026-01-01 00:00", end: "2026-01-31 00:00", city: "Москва" }).'
			}
		},
		{
			data: {
				number: '7',
				name: 'astro3d — календарь',
				base_url: 'https://astro3d.ru/api/v1/calendar?year=${year}&month=${month}&city=${city}',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: proxyId,
				is_active: false,
				description:
					'Астрологический календарь событий на год или месяц. Параметры: year — год (по умолчанию текущий), month — месяц 1-12 (необязательный), city — город. Без month — весь год. Пример: apiCall(svc, { year: 2026, month: 8, city: "Москва" }).'
			}
		},
		{
			data: {
				number: '8',
				name: 'OpenStreetMap — геокодинг (Nominatim)',
				base_url:
					'https://nominatim.openstreetmap.org/search?q=${query}&format=jsonv2&accept-language=ru&limit=1',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: '',
				is_active: true,
				description:
					'Координаты по наименованию: геокодинг OpenStreetMap (Nominatim). Параметр ${query} — наименование места, может быть на русском (URL-кодируется автоматически, accept-language=ru даёт русские названия). Ответ — JSON-массив мест; у первого результата координаты: res.data[0].lat и res.data[0].lon. Без прокси — прямой запрос из браузера (Nominatim разрешает CORS). Пример: apiCall(svc, { query: "Эрмитаж, Санкт-Петербург" }).'
			}
		}
	];

	if (services.length === 0 && !(await hasServerRows(servicesId, online))) {
		const rows: LocalRecord[] = defs.map((def) => ({
			id: def.id ?? crypto.randomUUID(),
			table_id: servicesId,
			status: 'draft',
			is_folder: false,
			parent_id: null,
			data: def.data,
			is_dirty: 1,
			updated_at: now
		}));
		for (const row of rows) await seedRecord(row, online);
	} else {
		// Каталог уже заполнен (существующая установка): новые дефолтные записи
		// (например, OpenStreetMap) досеиваем по name — только отсутствующие,
		// существующие (в т.ч. отредактированные вручную) не трогаем.
		for (const def of defs) {
			const name = def.data.name;
			if (!name || (await serviceExists(servicesId, name, online))) continue;
			await seedRecord(
				{
					id: def.id ?? crypto.randomUUID(),
					table_id: servicesId,
					status: 'draft',
					is_folder: false,
					parent_id: null,
					data: def.data,
					is_dirty: 1,
					updated_at: now
				},
				online
			);
		}
	}
}

// Маркеры устаревших seed-версий runCode, которые стоит заменить актуальной:
// битая версия (await внутри не-async filter), версия с прямым fetch к endpoint,
// первая прокси-версия без ключа авторизации шлюза, версия на notify_providers,
// версия, где сервис брался из поля «Провайдер» документа «Сообщение», и версия
// на отдельный справочник получателей notify_recipients (line.data.recipient).
const RUN_CODE_LEGACY = [
	"await findTableId('notify_message_channels')",
	"effective.data.endpoint + '?notify_key='",
	'JSON.stringify({\n\t\turl: effective.data.endpoint,',
	"findTableId('notify_providers')",
	'record.data.provider',
	'const effective = service || services.find(',
	'line.data.recipient',
	"findTableId('notify_recipients')"
];

// Точечное лечение runCode документа «Сообщение» на сервере: ensureTable
// перезаписывает локальный кэш, но существующую серверную строку не трогает.
async function reconcileMessageRunCode(messagesId: string, online: boolean): Promise<void> {
	if (!online) return;
	let serverConfig: Record<string, any> | null = null;
	try {
		const { data } = await supabase
			.from('meta_tables')
			.select('config')
			.eq('id', messagesId)
			.maybeSingle();
		serverConfig = data?.config ?? null;
	} catch {
		return;
	}
	const current = serverConfig?.runCode;
	if (typeof current !== 'string' || current === NOTIFY_RUN_CODE) return;
	if (!RUN_CODE_LEGACY.some((marker) => current.includes(marker))) return;

	try {
		await supabase
			.from('meta_tables')
			.update({ config: { ...serverConfig, runCode: NOTIFY_RUN_CODE } })
			.eq('id', messagesId);
		console.log('Восстановлен актуальный код отправки уведомлений (runCode).');
	} catch {
		// сервер недоступен — залечим при следующем цикле синхронизации
	}
}

// Идемпотентное создание таблиц модуля уведомлений. Вызывается из
// metadata.ensureSystemTables() — при старте приложения и перед каждым синком.
export async function ensureNotificationTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	// Порядок важен: у колонок-ссылок должен быть реальный id таблицы-цели.
	const servicesId = await ensureTable(API_SERVICES_TABLE, 'Сервисы API', 'directory', {});
	await migrateLegacyNotifyProviders(online);
	const channelsId = await ensureTable(NOTIFY_CHANNELS_TABLE, 'Каналы отправки', 'directory', {});
	const messagesId = await ensureTable(NOTIFY_MESSAGES_TABLE, 'Сообщение', 'document', {
		features: { run: true },
		runCode: NOTIFY_RUN_CODE
	});
	const messageChannelsId = await ensureTable(
		NOTIFY_MESSAGE_CHANNELS_TABLE,
		'Получатели',
		'tabular',
		{},
		messagesId
	);

	await ensureColumns(servicesId, serviceColumns(servicesId), online);
	await ensureColumns(channelsId, channelColumns(servicesId), online);
	await ensureColumns(messagesId, messageColumns(), online);

	// Контрагенты существуют на сервере; в пустом локальном кэше их ещё может не быть.
	const counterpartiesId = await findTableIdByName('counterparties');

	// ТЧ «Контакты» у контрагентов (подчинённая таблица: канал + значение)
	if (counterpartiesId) {
		await reconcileContacts(counterpartiesId, channelsId, online);
	}

	// ТЧ «Получатели» сообщения: [Контрагент, Канал], legacy-колонка удаляется
	await reconcileMessageTabular(messageChannelsId, counterpartiesId, channelsId, online);

	// Лечение ранней (битой) версии seed-кода: в ней await был внутри не-async
	// стрелочной функции filter(...) — такой код не проходит парсинг. ensureTable
	// перезаписывает локальный кэш актуальным кодом, но на сервере таблица уже
	// существует со старой строкой — обновляем её точечно, не трогая ручные правки.
	await reconcileMessageRunCode(messagesId, online);

	// Офлайн-старт: сиды по умолчанию создаём сразу, чтобы справочники были
	// доступны без сети. Онлайн-сид выполняется ПОСЛЕ pullDataChanges (см.
	// seedNotificationDefaults в runFullSync): иначе свежие updated_at сидов
	// сдвигают вотермарк pullDataChanges вперёд, и записи с сервера (получатели,
	// сообщения) не попадут в локальный кэш после полного обновления.
	if (!online) await seedDefaults(servicesId, channelsId, online);
}

// Сид справочников по умолчанию ПОСЛЕ синхронизации: вызывается из runFullSync
// сразу после pullDataChanges. К этому моменту в локальный кэш уже затянуты
// записи с сервера, поэтому новые каналы/сервисы не дублируются. Если же синк
// был офлайн или сервер пуст — сидим локально (is_dirty=1).
export async function seedNotificationDefaults(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;
	const servicesId = (await db.meta_tables.where('name').equals(API_SERVICES_TABLE).first())?.id;
	const channelsId = (await db.meta_tables.where('name').equals(NOTIFY_CHANNELS_TABLE).first())?.id;
	if (!servicesId || !channelsId) return;
	await seedDefaults(servicesId, channelsId, online);
}
