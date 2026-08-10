import { supabase } from '$lib/db/supabase';
import { db, type LocalRecord } from '$lib/db/indexeddb';
import {
	ensureColumns,
	ensureTable,
	findTableIdByName,
	hasServerRows,
	seedRecord,
	type ColumnSeed
} from '$lib/state/seed';

// Модуль уведомлений: каталог «Сервисы API», справочник каналов отправки,
// табличная часть «Контакты» у контрагентов и документ «Сообщение» для
// рассылки через внешний endpoint (например, /api/notify). Таблицы создаются
// идемпотентно (код-сид) при старте приложения и в начале каждого цикла
// синхронизации — по паттерну системной таблицы «История».

export const API_SERVICES_TABLE = 'api_services';
export const NOTIFY_CHANNELS_TABLE = 'notify_channels';
export const NOTIFY_MESSAGES_TABLE = 'notify_messages';
export const NOTIFY_MESSAGE_CHANNELS_TABLE = 'notify_message_channels';

// Табличная часть «Контакты» у контрагентов: строки хранятся в data_lines
// (record_id = id контрагента), каждая строка = канал отправки + значение.
export const CONTACT_TABLE = 'contragent_contacts';

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
	message: String(record.data.message || record.data.subject || '').slice(0, 4000),
	subject: String(record.data.subject || '').slice(0, 200)
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

// Есть ли в каталоге «Сервисы API» запись с данным name (локально или на сервере).
// После pullDataChanges локальный кэш полон, поэтому сначала проверяем его —
// серверный запрос делаем только если локально каталог пуст (один раз, а не
// по одному запросу на каждое имя — раньше это было ~10 запросов каждый цикл).
async function collectServiceNames(servicesId: string, online: boolean): Promise<Set<string>> {
	const local = await db.data_records.where('table_id').equals(servicesId).toArray();
	const localNames = new Set(local.map((r) => String(r.data?.name ?? '')).filter(Boolean));
	if (localNames.size > 0 || !online) return localNames;
	try {
		const { data } = await supabase
			.from('data_records')
			.select('data')
			.eq('table_id', servicesId)
			.limit(1000);
		return new Set((data ?? []).map((r: any) => String(r.data?.name ?? '')).filter(Boolean));
	} catch {
		return localNames; // сервер недоступен — сверяемся только с локальным кэшем
	}
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
		},
		{
			data: {
				number: '9',
				name: 'astro3d — переводчик',
				base_url: 'https://astro3d.ru/api/translate?q=${word}&tl=${langt}&sl=${langs}',
				method: 'GET',
				auth_type: 'none',
				auth_param: '',
				api_key: '',
				headers: '{}',
				proxy: '',
				is_active: true,
				description:
					'Перевод слов с языка ${langs} на ${langt} (например, синонима в конфигураторе → латинское имя поля). Используется автоподстановкой name из синонима (см. «Сервис перевода» в конструкторе). Параметры: word — текст, langs — исходный язык, langt — целевой. Без прокси — прямой запрос из браузера (у astro3d.ru CORS открыт). Ответ: { translated_text, detected_language }. Пример: apiCall(svc, { word: "Контакты", langs: "ru", langt: "en" }).'
			}
		},
		{
			data: {
				number: '10',
				name: 'Renderer — HTML/SVG в PNG/PDF',
				base_url: 'https://astro3d.ru/api/render',
				method: 'POST',
				auth_type: 'query',
				auth_param: 'notify_key',
				api_key: '',
				headers: '{}',
				proxy: proxyId,
				is_active: true,
				description:
					'Рендер HTML или SVG в PNG/PDF серверным браузером (chrome-headless-shell). Вызов из кода: apiCall(svc, {}, { kind: "html"|"svg", html: "<h1>Отчёт</h1>", svg: "<svg...>", width: 794, format: "png"|"pdf" }). Ответ: { data: base64, content_type }. Идёт через прокси (поле «Прокси»), «Ключ доступа» — тот же NOTIFY_KEY, что у сервиса уведомлений.'
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
		// (например, OpenStreetMap, переводчик) досеиваем — только отсутствующие,
		// существующие (в т.ч. отредактированные вручную) не трогаем.
		const existingBaseUrls = new Set(services.map((r) => r.data?.base_url));
		const existingNames = await collectServiceNames(servicesId, online);
		for (const def of defs) {
			const name = def.data.name;
			if (!name || existingNames.has(name)) continue;
			// Защита от дублей по URL: переводчик мог быть создан вручную под другим
			// именем — такую запись не дублируем, берём её как есть.
			if (def.data.base_url && existingBaseUrls.has(def.data.base_url)) continue;
			existingNames.add(name);
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

// Идемпотентное создание таблиц модуля уведомлений. Вызывается из
// metadata.ensureSystemTables() — при старте приложения и перед каждым синком.
export async function ensureNotificationTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	// Порядок важен: у колонок-ссылок должен быть реальный id таблицы-цели.
	const servicesId = await ensureTable(API_SERVICES_TABLE, 'Сервисы API', 'directory', {});
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

	// ТЧ «Получатели» сообщения: [Контрагент, Канал]
	await reconcileMessageTabular(messageChannelsId, counterpartiesId, channelsId, online);

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
