import type { TableTypeModule } from './type';

// Служебный тип для табличных частей (подчинённых таблиц)
const tabular: TableTypeModule = {
	type: 'tabular',
	label: 'Табличная часть',
	statuses: [
		{ value: 'draft', label: 'Записан', icon: '⚪', badgeClass: 'status-draft', isReadOnly: false }
	],
	features: {
		create: false,
		save: true,
		post: false,
		copy: false,
		print: false,
		massOperations: false,
		hierarchy: false,
		delete: false,
		run: false,
		tabularSections: false
	},
	actions: [],
	fields: []
};

export default tabular;
