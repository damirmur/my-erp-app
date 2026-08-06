import { parseHash, resolveLink } from '$lib/services/deeplink';
import { runApiCommand, type ApiCommandResult } from '$lib/services/apiCommand';
import { db } from '$lib/db/indexeddb';
import { supabase } from '$lib/db/supabase';
import { HISTORY_TABLE_NAME } from '$lib/state/metadata';

// Максимальная глубина истории действий
const HISTORY_LIMIT = 50;

// Человекочитаемые подписи статусов записи для события «сохранение»
const STATUS_LABELS: Record<string, string> = {
	draft: 'черновик',
	posted: 'проведён',
	marked_for_deletion: 'помечен на удаление'
};

// Описываем интерфейс вкладки нашей ERP-системы
export interface WorkspaceTab {
	id: string; // Уникальный ID вкладки (например, "list_goods" или "form_invoice_uuid")
	type: 'list' | 'form'; // Тип вкладки: Список элементов или Форма документа/справочника
	tableId: string; // ID таблицы метаданных (ссылка на meta_tables.id)
	recordId?: string; // ID конкретной записи (только для форм)
	focusLineId?: string; // ID строки табличной части, которую нужно выделить при открытии формы
	title: string; // Заголовок вкладки (например, "Товары (список)" или "Накладная №5")
	isDirty: boolean; // Флаг измененности (есть ли несохраненные данные, аналог "*" в 1С)
}

class WorkspaceManager {
	// Используем руны Svelte 5 для создания глубоко реактивного состояния
	tabs = $state<WorkspaceTab[]>([]);
	activeTabId = $state<string | null>(null);
	sidebarCollapsed = $state(false);
	mode = $state<'main' | 'constructor'>('main');

	// Панель «API»: результат API-команды (#/t/{id}.json, #/r/{id}.json,
	// #/r/{id}.execute({...}).json) или возвращаемое значение «▶️ Выполнить».
	apiResult = $state<ApiCommandResult | null>(null);

	// Таблицы-константы, форма которых уже открывалась автоматически (или закрыта вручную).
	// Подавление переживает перемонтирование списка и сбрасывается при открытии списка заново.
	private constantFormOpened = new Set<string>();

	// Вычисляемое свойство через руну $derived: возвращает объект текущего активного таба
	activeTab = $derived(this.tabs.find((t) => t.id === this.activeTabId) || null);

	// Записать изменение в историю. История хранится в системной таблице «История»
	// (meta_tables.name = 'history') как обычные записи data_records:
	// data = { object_title, link, opened_at, event, event_type }. Сам изменяемый
	// объект не должен быть системной таблицей, иначе запись зациклится.
	// Журнал изменений: 'save'/'delete' — каждая операция пишется отдельной записью.
	// Открытия в историю не фиксируются.
	async recordHistory(
		tableId: string,
		title: string,
		link: string,
		event: 'save' | 'delete',
		status?: string
	) {
		try {
			const meta = await db.meta_tables.get(tableId);
			if (meta?.type === 'system') return;

			const historyTable = await db.meta_tables.where('name').equals(HISTORY_TABLE_NAME).first();
			if (!historyTable) return;

			const now = new Date().toISOString();
			let eventLabel = 'удаление';
			if (event === 'save') {
				eventLabel = status ? `сохранение (${STATUS_LABELS[status] ?? status})` : 'сохранение';
			}

			await db.transaction('rw', [db.data_records], async () => {
				await db.data_records.put({
					id: crypto.randomUUID(),
					table_id: historyTable.id,
					status: 'draft',
					is_folder: false,
					parent_id: null,
					data: { object_title: title, link, opened_at: now, event: eventLabel, event_type: event },
					is_dirty: 1,
					updated_at: now
				});
				// Ограничиваем глубину истории (свежие записи выше по opened_at)
				const all = await db.data_records.where('table_id').equals(historyTable.id).toArray();
				const sorted = all.sort((a, b) =>
					String(a.data?.opened_at) < String(b.data?.opened_at) ? 1 : -1
				);
				for (const r of sorted.slice(HISTORY_LIMIT)) await db.data_records.delete(r.id);
			});
		} catch (e) {
			console.warn('Не удалось записать действие в историю:', e);
		}
	}

	// Очистить историю действий (локально и на сервере)
	async clearHistory() {
		try {
			const historyTable = await db.meta_tables.where('name').equals(HISTORY_TABLE_NAME).first();
			if (!historyTable) return;
			await db.data_records.where('table_id').equals(historyTable.id).delete();
			await supabase.from('data_records').delete().eq('table_id', historyTable.id);
		} catch (e) {
			console.warn('Не удалось очистить историю:', e);
		}
	}

	// 1. Открыть форму списка таблицы (аналог ФормыСписка в 1С)
	openList(tableId: string, tableTitle: string) {
		const tabId = `list_${tableId}`;

		// Если вкладка со списком уже открыта, просто переключаемся на неё
		const existingTab = this.tabs.find((t) => t.id === tabId);
		if (existingTab) {
			this.activeTabId = tabId;
		} else {
			// Новое открытие списка сбрасывает подавление автооткрытия формы константы
			this.constantFormOpened.delete(tableId);

			// Иначе добавляем новую вкладку в массив
			this.tabs.push({
				id: tabId,
				type: 'list',
				tableId,
				title: `${tableTitle} (список)`,
				isDirty: false
			});
			this.activeTabId = tabId;
		}
	}

	// 2. Открыть форму элемента/документа (аналог ФормыЭлемента/ФормыДокумента в 1С)
	openForm(tableId: string, recordId: string | 'new', tableTitle: string, recordNumber?: string) {
		// Если это новый элемент, генерируем временный ID для вкладки
		const actualRecordId = recordId === 'new' ? crypto.randomUUID() : recordId;
		const tabId = `form_${tableId}_${actualRecordId}`;

		const existingTab = this.tabs.find((t) => t.id === tabId);
		if (existingTab) {
			this.activeTabId = tabId;
			return;
		}

		const title =
			recordId === 'new' ? `Новый ${tableTitle}` : `${tableTitle} №${recordNumber || '...'}`;

		this.tabs.push({
			id: tabId,
			type: 'form',
			tableId,
			recordId: actualRecordId,
			title,
			isDirty: recordId === 'new' // Новая запись сразу считается измененной
		});
		this.activeTabId = tabId;
	}

	// 2.1. Открыть форму записи и выделить в ней строку табличной части.
	// Открывает (или переиспользует) форму родительской записи и помечает нужную строку.
	openFormWithLine(
		tableId: string,
		recordId: string,
		tableTitle: string,
		lineId: string,
		recordNumber?: string
	) {
		const tabId = `form_${tableId}_${recordId}`;

		const existingTab = this.tabs.find((t) => t.id === tabId);
		if (existingTab) {
			existingTab.focusLineId = lineId;
			this.activeTabId = tabId;
		} else {
			const title = `${tableTitle} №${recordNumber || '...'}`;
			this.tabs.push({
				id: tabId,
				type: 'form',
				tableId,
				recordId,
				focusLineId: lineId,
				title,
				isDirty: false
			});
			this.activeTabId = tabId;
		}
	}

	// 2.2. Открыть объект по уникальной ссылке (#/t/..., #/r/..., #/l/...).
	// Возвращает true, если ссылка распознана и открыта.
	async openFromLink(linkHash: string): Promise<boolean> {
		const link = parseHash(linkHash);
		if (!link) return false;

		// API-режим: данные/выполнение кода без открытия формы или списка.
		// Результат показывается в панели «API» (apiResult). Панель открываем
		// только при ошибке или реальном возвращаемом значении — иначе код,
		// который ничего не вернул (value = undefined), выскакивал бы пустым.
		if (link.kind === 'execute' || link.kind === 'recordJson' || link.kind === 'listJson') {
			const result = await runApiCommand(link);
			if (!result) return false;
			if (!result.ok || result.value !== undefined) {
				this.apiResult = result;
			}
			return true;
		}

		if (link.kind === 'list') {
			const resolved = await resolveLink(link);
			if (!resolved || resolved.kind !== 'list') return false;
			this.openList(resolved.table.id, resolved.table.title);
			return true;
		}

		if (link.kind === 'record') {
			const resolved = await resolveLink(link);
			if (!resolved || resolved.kind !== 'record') return false;
			const number = resolved.record.data?.number || resolved.record.data?.name;
			this.openForm(resolved.table.id, resolved.record.id, resolved.table.title, number);
			return true;
		}

		const resolved = await resolveLink(link);
		if (!resolved || resolved.kind !== 'line') return false;
		const number = resolved.record.data?.number || resolved.record.data?.name;
		this.openFormWithLine(
			resolved.table.id,
			resolved.record.id,
			resolved.table.title,
			resolved.line.id,
			number
		);
		return true;
	}

	// 3. Закрыть вкладку (с проверкой на модифицированность данных)
	closeTab(tabId: string) {
		const tabIndex = this.tabs.findIndex((t) => t.id === tabId);
		if (tabIndex === -1) return;

		const tab = this.tabs[tabIndex];

		// Имитируем поведение 1С: предупреждаем пользователя о несохраненных данных
		if (tab.isDirty) {
			const confirmClose = confirm(
				`Данные во вкладке "${tab.title}" были изменены. Закрыть без сохранения?`
			);
			if (!confirmClose) return;
		}

		// Закрытие формы константы вручную подавляет её повторное автооткрытие
		this.constantFormOpened.add(tab.tableId);

		// Удаляем вкладку из массива (мутации массивов во Svelte 5 триггерят реактивность автоматически)
		this.tabs.splice(tabIndex, 1);

		// Если закрыли активную вкладку, переключаем фокус на соседнюю
		if (this.activeTabId === tabId) {
			if (this.tabs.length > 0) {
				// Фокус на предыдущую или первую оставшуюся вкладку
				const nextActiveIndex = Math.max(0, tabIndex - 1);
				this.activeTabId = this.tabs[nextActiveIndex].id;
			} else {
				this.activeTabId = null;
			}
		}
	}

	// 4. Скрыть/показать боковую панель
	toggleSidebar() {
		this.sidebarCollapsed = !this.sidebarCollapsed;
	}

	// 5. Переключить режим интерфейса: основной или конструктор
	setMode(mode: 'main' | 'constructor') {
		this.mode = mode;
	}

	// 6. Открыть конфигуратор таблицы в отдельной вкладке (одна таблица — одна вкладка)
	openConfigurator(tableId: string, tableTitle: string) {
		const tabId = `form_SYSTEM_CONFIUGRATOR_ID_${tableId}`;

		const existingTab = this.tabs.find((t) => t.id === tabId);
		if (existingTab) {
			this.activeTabId = tabId;
			return;
		}

		this.tabs.push({
			id: tabId,
			type: 'form',
			tableId: 'SYSTEM_CONFIUGRATOR_ID',
			recordId: tableId,
			title: `⚙️ ${tableTitle}`,
			isDirty: false
		});
		this.activeTabId = tabId;
	}

	// 7. Принудительно закрыть вкладку без подтверждения (например, после удаления таблицы)
	closeTabForce(tabId: string) {
		const tabIndex = this.tabs.findIndex((t) => t.id === tabId);
		if (tabIndex === -1) return;
		this.tabs.splice(tabIndex, 1);
		if (this.activeTabId === tabId) {
			if (this.tabs.length > 0) {
				const nextActiveIndex = Math.max(0, tabIndex - 1);
				this.activeTabId = this.tabs[nextActiveIndex].id;
			} else {
				this.activeTabId = null;
			}
		}
	}

	// 8. Закрыть вкладку конфигуратора конкретной таблицы
	closeConfiguratorForTable(tableId: string) {
		this.closeTabForce(`form_SYSTEM_CONFIUGRATOR_ID_${tableId}`);
	}

	// 8a. Открыть вкладку редактора типов. Вкладка общая (одна на все типы):
	// recordId хранит текущий тип, переключение типов внутри вкладки меняет его.
	openTypeConfigurator(typeName: string, label: string) {
		const tabId = 'form_SYSTEM_TYPE_CONFIGURATOR_ID';
		const title = `🗂 Тип: ${label}`;
		const existing = this.tabs.find((t) => t.id === tabId);
		if (existing) {
			existing.recordId = typeName;
			existing.title = title;
			this.activeTabId = tabId;
			return;
		}
		this.tabs.push({
			id: tabId,
			type: 'form',
			tableId: 'SYSTEM_TYPE_CONFIGURATOR_ID',
			recordId: typeName,
			title,
			isDirty: false
		});
		this.activeTabId = tabId;
	}

	// 9. Установить флаг модифицированности (вызывается при вводе данных в инпуты)
	setDirty(tabId: string, isDirty: boolean) {
		const tab = this.tabs.find((t) => t.id === tabId);
		if (tab) {
			tab.isDirty = isDirty;
		}
	}

	// 10. Обновить заголовок вкладки (например, когда документ записали и он получил номер)
	updateTabTitle(tabId: string, newTitle: string) {
		const tab = this.tabs.find((t) => t.id === tabId);
		if (tab) {
			tab.title = newTitle;
		}
	}

	// 11. Отметить, что форма константы уже открывалась автоматически (не открывать повторно)
	suppressConstantAutoOpen(tableId: string) {
		this.constantFormOpened.add(tableId);
	}

	// 12. Проверить, подавлено ли автооткрытие формы константы
	isConstantAutoOpenSuppressed(tableId: string): boolean {
		return this.constantFormOpened.has(tableId);
	}

	// 13. Показать результат в панели «API» (из «▶️ Выполнить» или API-ссылки)
	showApiResult(result: ApiCommandResult) {
		this.apiResult = result;
	}

	// 14. Закрыть панель «API»
	closeApiResult() {
		this.apiResult = null;
	}
}

// Экспортируем единственный экземпляр (синглтон) нашего менеджера для всего приложения
export const workspace = new WorkspaceManager();
