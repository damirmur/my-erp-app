import type { TableTypeModule } from './type';

// Служебный тип для табличных частей (подчинённых таблиц)
const tabular: TableTypeModule = {
	type: 'tabular',
	label: 'Табличная часть',
	statuses: [
		{ value: 'draft', label: 'Черновик', icon: '⚪', badgeClass: 'status-draft', isReadOnly: false }
	],
	features: {
		hierarchy: false,
		copy: false,
		print: false,
		tabularSections: false
	},
	actions: [{ id: 'save', label: 'Записать', icon: '💾', type: 'form' }]
};

export default tabular;
