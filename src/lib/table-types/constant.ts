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
	fields: [{ name: 'value', title: 'Значение', type: 'string' }]
};

export default constant;
