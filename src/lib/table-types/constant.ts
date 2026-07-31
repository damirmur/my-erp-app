import type { TableTypeModule } from './type';

const constant: TableTypeModule = {
	type: 'constant',
	label: 'Константа',
	statuses: [
		{
			value: 'draft',
			label: 'Записан',
			icon: '⚪',
			badgeClass: 'status-draft',
			isReadOnly: false
		}
	],
	features: {
		hierarchy: false,
		copy: false,
		print: false,
		tabularSections: false
	},
	actions: [{ id: 'save', label: 'Записать', icon: '💾', type: 'form' }],
	fields: [{ name: 'value', title: 'Значение', type: 'string' }]
};

export default constant;
