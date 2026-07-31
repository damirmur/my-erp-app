export interface StatusDef {
	value: string;
	label: string;
	icon: string;
	badgeClass: string;
	isReadOnly: boolean;
	// Семантическая роль статуса: от неё зависят стандартные кнопки
	role?: 'posted' | 'deleted';
}

export interface ActionDef {
	id: string;
	label: string;
	icon: string;
	type: 'list' | 'form';
	variant?: 'primary' | 'success' | 'danger' | 'warning' | 'text-danger' | 'text-success';
	show?: (status: string) => boolean;
	disabled?: (status: string) => boolean;
}

export interface ActionDefDB {
	id: string;
	label: string;
	icon: string;
	type: 'list' | 'form';
	variant?: 'primary' | 'success' | 'danger' | 'warning' | 'text-danger' | 'text-success';
	showWhen?: string;
	showWhenNot?: string;
	disabledWhen?: string;
}

// Возможности типа: фичи — источник истины, стандартные кнопки генерируются из них
export interface TableTypeFeatures {
	create: boolean; // ➕ Создать (в списке)
	save: boolean; // 💾 Записать (в форме)
	post: boolean; // ✔️ Провести / Отменить проведение
	copy: boolean; // 📋 Копировать (список и форма)
	print: boolean; // 🖨️ Печать (список и форма)
	massOperations: boolean; // Массовые: провести/пометить/восстановить
	hierarchy: boolean; // Группы/папки (иерархия)
	tabularSections: boolean; // Табличные части
	delete: boolean; // 🗑️ Физическое удаление записей (без пометки)
	run: boolean; // ▶️ Выполнить: запуск пользовательского JS-кода (config.runCode) по записи(ям)
}

export const FEATURE_KEYS: (keyof TableTypeFeatures)[] = [
	'create',
	'save',
	'post',
	'copy',
	'print',
	'massOperations',
	'hierarchy',
	'tabularSections',
	'delete',
	'run'
];

export const FEATURE_LABELS: Record<keyof TableTypeFeatures, string> = {
	create: 'Создание',
	save: 'Запись',
	post: 'Проведение',
	copy: 'Копирование',
	print: 'Печать',
	massOperations: 'Массовые операции',
	hierarchy: 'Иерархия (группы/папки)',
	tabularSections: 'Табличные части',
	delete: 'Физическое удаление',
	run: 'Выполнить (JS-код)'
};

// Шаблон поля: колонки, создаваемые автоматически при создании таблицы этого типа
export interface FieldTemplate {
	name: string;
	title: string;
	type: string;
	related_table_id?: string | null;
}

export interface TableTypeModule {
	type: string;
	label: string;
	statuses: StatusDef[];
	features: TableTypeFeatures;
	actions: ActionDef[];
	fields?: FieldTemplate[];
}
