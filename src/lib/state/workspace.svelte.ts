// Описываем интерфейс вкладки нашей ERP-системы
export interface WorkspaceTab {
    id: string;          // Уникальный ID вкладки (например, "list_goods" или "form_invoice_uuid")
    type: 'list' | 'form'; // Тип вкладки: Список элементов или Форма документа/справочника
    tableId: string;     // ID таблицы метаданных (ссылка на meta_tables.id)
    recordId?: string;   // ID конкретной записи (только для форм)
    title: string;       // Заголовок вкладки (например, "Товары (список)" или "Накладная №5")
    isDirty: boolean;    // Флаг измененности (есть ли несохраненные данные, аналог "*" в 1С)
}

class WorkspaceManager {
    // Используем руны Svelte 5 для создания глубоко реактивного состояния
    tabs = $state<WorkspaceTab[]>([]);
    activeTabId = $state<string | null>(null);

    // Вычисляемое свойство через руну $derived: возвращает объект текущего активного таба
    activeTab = $derived(this.tabs.find(t => t.id === this.activeTabId) || null);

    // 1. Открыть форму списка таблицы (аналог ФормыСписка в 1С)
    openList(tableId: string, tableTitle: string) {
        const tabId = `list_${tableId}`;
        
        // Если вкладка со списком уже открыта, просто переключаемся на неё
        const existingTab = this.tabs.find(t => t.id === tabId);
        if (existingTab) {
            this.activeTabId = tabId;
            return;
        }

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

    // 2. Открыть форму элемента/документа (аналог ФормыЭлемента/ФормыДокумента в 1С)
    openForm(tableId: string, recordId: string | 'new', tableTitle: string, recordNumber?: string) {
        // Если это новый элемент, генерируем временный ID для вкладки
        const actualRecordId = recordId === 'new' ? crypto.randomUUID() : recordId;
        const tabId = `form_${tableId}_${actualRecordId}`;

        const existingTab = this.tabs.find(t => t.id === tabId);
        if (existingTab) {
            this.activeTabId = tabId;
            return;
        }

        const title = recordId === 'new' 
            ? `Новый ${tableTitle}` 
            : `${tableTitle} №${recordNumber || '...'}`;

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

    // 3. Закрыть вкладку (с проверкой на модифицированность данных)
    closeTab(tabId: string) {
        const tabIndex = this.tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        const tab = this.tabs[tabIndex];

        // Имитируем поведение 1С: предупреждаем пользователя о несохраненных данных
        if (tab.isDirty) {
            const confirmClose = confirm(`Данные во вкладке "${tab.title}" были изменены. Закрыть без сохранения?`);
            if (!confirmClose) return;
        }

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

    // 4. Установить флаг модифицированности (вызывается при вводе данных в инпуты)
    setDirty(tabId: string, isDirty: boolean) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            tab.isDirty = isDirty;
        }
    }

    // 5. Обновить заголовок вкладки (например, когда документ записали и он получил номер)
    updateTabTitle(tabId: string, newTitle: string) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            tab.title = newTitle;
        }
    }
}

// Экспортируем единственный экземпляр (синглтон) нашего менеджера для всего приложения
export const workspace = new WorkspaceManager();
