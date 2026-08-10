import { db, type LocalColumn } from '$lib/db/indexeddb';
import { API_SERVICES_TABLE, NOTIFY_CHANNELS_TABLE } from '$lib/state/notifications';
import { ensureColumns, ensureTable, findTableIdByName } from '$lib/state/seed';

// Модуль расписаний: документ «Расписание» для периодической рассылки
// (например, погоды). Таблицы создаются идемпотентно (код-сид) при старте
// приложения и в начале каждого цикла синхронизации — по паттерну модуля
// уведомлений.
//
// Исполнение по расписанию выполняет Go-сервер (24/7): читает активные
// расписания из Supabase, запрашивает сервис API (по умолчанию wttr.in),
// подставляет значения в шаблон и отправляет через /api/notify. Результаты
// пишет обратно в запись (last_run_at/next_run_at/last_result/last_response),
// приложение подхватывает их через pullDataChanges. Время «HH:MM» — местное
// для часового пояса из поля timezone, а если оно пусто — из константы
// «Временная зона» (meta_tables.name='tz').
//
// Кнопка «▶️ Выполнить» в форме расписания — ручной запуск из браузера:
// создаёт документ «Сообщение» с отформатированным текстом и получателями
// расписания, затем отправляет через штатный код «Сообщения» (NOTIFY_RUN_CODE).

export const SCHEDULES_TABLE = 'schedules';
export const SCHEDULE_RECIPIENTS_TABLE = 'schedule_recipients';

// Код действия «▶️ Выполнить» документа «Расписание»: запрашивает сервис API,
// подставляет {{путь}} из ответа в шаблон, создаёт «Сообщение» с получателями
// расписания и вызывает код «Сообщения» (NOTIFY_RUN_CODE) через хелпер run().
export const SCHEDULE_RUN_CODE = `
// Ручной запуск расписания из браузера (тест / «выполнить сейчас»)
const findTable = async (name) => {
	const t = await db.meta_tables.where('name').equals(name).first();
	if (!t) throw new Error('Нет таблицы ' + name);
	return t;
};

// 1. Запрос к сервису API (apiCall из контекста действия)
const service = record.data.service ? await db.data_records.get(record.data.service) : null;
if (!service) throw new Error('Не задан сервис API (поле «Сервис API»)');
const params =
	record.data.params && typeof record.data.params === 'object' && !Array.isArray(record.data.params)
		? record.data.params
		: {};
const res = await apiCall(service, params);
if (!res.ok) throw new Error('Ошибка запроса API: ' + res.status + ' ' + res.raw);

// 2. Подстановка {{путь}} в шаблоне из ответа (точка и индексы массивов)
const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
let text = String(record.data.message_template || '');
text = text.replace(/\\{\\{([\\w.]+)\\}\\}/g, (m, p) => {
	if (p === 'city') return String(params.city ?? params.city_name ?? '');
	const v = pick(res.data, p);
	return v == null ? m : String(Array.isArray(v) ? v[0] : v);
});
text = text.replace(/\\{\\{now\\}\\}/g, new Date().toLocaleString('ru-RU'));

// 3. Создаём документ «Сообщение» с текстом и получателями расписания
const recTable = await findTable('schedules');
const msgTable = await findTable('notify_messages');
const msgRecTable = await findTable('schedule_recipients');
const now = new Date().toISOString();
const msgId = crypto.randomUUID();
await db.data_records.put({
	id: msgId,
	table_id: msgTable.id,
	status: 'draft',
	is_dirty: 1,
	updated_at: now,
	data: {
		number: String(record.data.number || ''),
		date: now.slice(0, 10),
		subject: 'Расписание: ' + (record.data.name || record.data.number || ''),
		message: text
	}
});
const recLines = (lines || []).filter((l) => l.table_id === recTable.id);
const msgLines = recLines.map((l, i) => ({
	id: crypto.randomUUID(),
	record_id: msgId,
	table_id: msgRecTable.id,
	data: { kontragent: l.data.kontragent ?? null, channel: l.data.channel ?? null },
	sort_order: i + 1
}));
if (msgLines.length > 0) await db.data_lines.bulkPut(msgLines);

// 4. Отправляем через штатный код документа «Сообщение» (NOTIFY_RUN_CODE)
await run('notify_messages', msgId);
log('Расписание выполнено, сообщение: ' + msgId);
`.trim();

type ColumnSeed = Omit<LocalColumn, 'id' | 'table_id'>;

// Колонки документа «Расписание». Поле-ссылка «Сервис API» — на каталог
// api_services; параметры (город и т.п.) задаются в jsonb-поле params.
function scheduleColumns(servicesId: string): ColumnSeed[] {
	return [
		{ name: 'number', title: 'Код', type: 'string', sort_order: 10, is_visible: true },
		{ name: 'name', title: 'Наименование', type: 'string', sort_order: 20, is_visible: true },
		{
			name: 'service',
			title: 'Сервис API',
			type: 'link',
			sort_order: 30,
			is_visible: true,
			related_table_id: servicesId
		},
		{
			name: 'params',
			title: 'Параметры (JSON)',
			type: 'jsonb',
			sort_order: 40,
			is_visible: false
		},
		{
			name: 'message_template',
			title: 'Шаблон сообщения',
			type: 'textarea',
			sort_order: 50,
			is_visible: true
		},
		{ name: 'time', title: 'Время (HH:MM)', type: 'string', sort_order: 60, is_visible: true },
		{
			name: 'days',
			title: 'Дни недели (1-7)',
			type: 'string',
			sort_order: 70,
			is_visible: false
		},
		{
			name: 'timezone',
			title: 'Часовой пояс (пусто — константа «Временная зона»)',
			type: 'string',
			sort_order: 80,
			is_visible: false
		},
		{ name: 'is_active', title: 'Активно', type: 'boolean', sort_order: 90, is_visible: false },
		{
			name: 'last_run_at',
			title: 'Последний запуск',
			type: 'date',
			sort_order: 100,
			is_visible: false
		},
		{
			name: 'next_run_at',
			title: 'Следующий запуск',
			type: 'date',
			sort_order: 110,
			is_visible: false
		},
		{ name: 'last_result', title: 'Результат', type: 'string', sort_order: 120, is_visible: false },
		{
			name: 'last_response',
			title: 'Ответ сервера',
			type: 'textarea',
			sort_order: 130,
			is_visible: false
		}
	];
}

// Колонки ТЧ «Получатели» расписания — как у «Сообщения»: Контрагент +
// (необязательно) Канал. Канал пуст — уходят все контакты контрагента.
function scheduleRecipientColumns(counterpartiesId: string, channelsId: string): ColumnSeed[] {
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

// Идемпотентное создание таблиц модуля расписаний. Вызывается из
// metadata.ensureSystemTables() — при старте приложения и перед каждым синком
// (после ensureNotificationTables, т.к. нужны каталог сервисов и каналы).
export async function ensureSchedulerTables(): Promise<void> {
	const online = typeof navigator === 'undefined' || navigator.onLine;

	const servicesId = (await db.meta_tables.where('name').equals(API_SERVICES_TABLE).first())?.id;
	const channelsId = (await db.meta_tables.where('name').equals(NOTIFY_CHANNELS_TABLE).first())?.id;
	const counterpartiesId = await findTableIdByName('counterparties');

	const schedulesId = await ensureTable(SCHEDULES_TABLE, 'Расписания', 'document', {
		features: { run: true },
		runCode: SCHEDULE_RUN_CODE
	});

	if (servicesId) {
		await ensureColumns(schedulesId, scheduleColumns(servicesId), online);
	}

	const recipientsId = await ensureTable(
		SCHEDULE_RECIPIENTS_TABLE,
		'Получатели',
		'tabular',
		{},
		schedulesId
	);
	if (counterpartiesId && channelsId) {
		await ensureColumns(
			recipientsId,
			scheduleRecipientColumns(counterpartiesId, channelsId),
			online
		);
	}
}
