import { ensureNotificationTables, seedNotificationDefaults } from '$lib/state/notifications';
import { ensureFlowTables } from '$lib/state/flows';
import { ensurePrintFormsTable } from '$lib/state/printForms';
import { ensureSettingsTable } from '$lib/state/settings';
import { ensureApiQueryTables } from '$lib/state/apiQueries';
import { ensureConstantsTable } from '$lib/state/constants';
import { ensureSolutionPacksTable } from '$lib/state/solutions';
import { ensureAccessTables } from '$lib/state/access';
import { db } from '$lib/db/indexeddb';

// Реестр модулей приложения. Модуль = группа таблиц + их идемпотентное создание
// (ensure) + опциональный сид справочников (seedDefaults, исполняется ПОСЛЕ
// pullDataChanges — чтобы свежие updated_at сидов не сдвинули вотермарк).
//
// Группы:
//   core     — движок, ставится всегда (история, настройки, печатные формы);
//   default  — устанавливается по умолчанию при старте (сценарии, уведомления);
//   optional — не ставится из boot, включается вручную (installModule) — модули,
//              которые живут как сценарии-данные (api-запросы, константы).
//
// Движок НЕ знает про конкретные таблицы модулей — каждый модуль сам описывает
// свои ensure/seedDefaults. История (history) обрабатывается отдельно в
// metadata.ensureSystemTables (у неё особый дедуп серверных дубликатов).

export interface ModuleDef {
	id: string;
	title: string;
	description: string;
	group: 'core' | 'default' | 'optional';
	// Имена таблиц модуля (для проверки установки/отображения в конструкторе).
	tables: string[];
	// Маркерная таблица для isInstalled (первая из tables обычно и есть).
	ensure: () => Promise<void>;
	seedDefaults?: () => Promise<void>;
}

export const CORE_MODULES: ModuleDef[] = [
	{
		id: 'settings',
		title: 'Настройки',
		description: 'Системная таблица app_settings: порядок меню, сервис перевода.',
		group: 'core',
		tables: ['app_settings'],
		ensure: ensureSettingsTable
	},
	{
		id: 'print_forms',
		title: 'Печатные формы',
		description: 'Реестр шаблонов печати (HTML/SVG) и способы вывода документов.',
		group: 'core',
		tables: ['print_forms'],
		ensure: ensurePrintFormsTable
	},
	{
		id: 'solutions',
		title: 'Пакеты решений',
		description:
			'Реестр пакетов решений: применение схемы (таблицы/колонки/типы), каталогов, сценариев и печатных форм из JSON-определения без кода.',
		group: 'core',
		tables: ['solution_packs'],
		ensure: ensureSolutionPacksTable
	},
	{
		id: 'access',
		title: 'Доступ',
		description:
			'Авторизация: «Роли», «Команда» (участники и роли), «Правила доступа» (кто x что x действие), режим защиты.',
		group: 'core',
		tables: ['access_roles', 'team_members', 'access_rules'],
		ensure: ensureAccessTables
	}
];

export const DEFAULT_MODULES: ModuleDef[] = [
	{
		id: 'notify',
		title: 'Уведомления/Сообщения',
		description: 'Сервисы API, каналы отправки, документ «Сообщение», контакты контрагентов.',
		group: 'default',
		tables: [
			'api_services',
			'notify_channels',
			'notify_messages',
			'notify_message_channels',
			'contragent_contacts'
		],
		ensure: ensureNotificationTables,
		seedDefaults: seedNotificationDefaults
	},
	{
		id: 'flow',
		title: 'Сценарии',
		description: 'Графовые сценарии (n8n-подобные): узлы, связи, элементы.',
		group: 'default',
		tables: ['flow_scenarios', 'flow_nodes', 'flow_links', 'flow_elements'],
		ensure: ensureFlowTables
	}
];

export const OPTIONAL_MODULES: ModuleDef[] = [
	{
		id: 'api_queries',
		title: 'API-запросы',
		description: 'Каталог готовых внешних вызовов по deep-link.',
		group: 'optional',
		tables: ['api_queries'],
		ensure: ensureApiQueryTables
	},
	{
		id: 'constants',
		title: 'Константы',
		description:
			'Таблица значений-констант (универсальное «Значение», периоды). Тип constant — в коде движка.',
		group: 'optional',
		tables: ['constants', 'constants_periods'],
		ensure: ensureConstantsTable
	}
];

export const ALL_MODULES: ModuleDef[] = [...CORE_MODULES, ...DEFAULT_MODULES, ...OPTIONAL_MODULES];

const BY_ID = new Map(ALL_MODULES.map((m) => [m.id, m]));

export function moduleById(id: string): ModuleDef | undefined {
	return BY_ID.get(id);
}

// Создание таблиц модуля (идемпотентно). Вызывается из boot для core+default.
export async function ensureModule(mod: ModuleDef): Promise<void> {
	await mod.ensure();
}

// Сид справочников модуля — строго после pullDataChanges (см. sync.ts).
export async function seedModule(mod: ModuleDef): Promise<void> {
	if (mod.seedDefaults) await mod.seedDefaults();
}

// Установлен ли модуль: есть ли в локальном кэше его маркерная таблица.
// Достаточно первого имени таблицы — метаданные тянутся на старте.
export async function isModuleInstalled(id: string): Promise<boolean> {
	const mod = BY_ID.get(id);
	if (!mod || mod.tables.length === 0) return false;
	const t = await db.meta_tables.where('name').equals(mod.tables[0]).first();
	return !!t;
}

// Вручную установить опциональный модуль: создать таблицы + сид справочников.
export async function installModule(id: string): Promise<void> {
	const mod = BY_ID.get(id);
	if (!mod) throw new Error('Нет модуля с id=' + id);
	if (mod.group === 'optional') {
		await mod.ensure();
		if (mod.seedDefaults) await mod.seedDefaults();
	}
}
