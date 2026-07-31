export interface StatusDef {
	value: string;
	label: string;
	icon: string;
	badgeClass: string;
	isReadOnly: boolean;
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

export interface TableTypeFeatures {
	hierarchy: boolean;
	copy: boolean;
	print: boolean;
	tabularSections: boolean;
}

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
