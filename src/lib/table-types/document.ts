import type { TableTypeModule } from './type';

const document: TableTypeModule = {
	type: 'document',
	label: 'Документ',
	statuses: [
		{
			value: 'draft',
			label: 'Черновик',
			icon: '⚪',
			badgeClass: 'status-draft',
			isReadOnly: false
		},
		{
			value: 'posted',
			label: 'Проведен',
			icon: '🟢',
			badgeClass: 'status-posted',
			isReadOnly: true,
			role: 'posted'
		},
		{
			value: 'marked_for_deletion',
			label: 'Помечен на удаление',
			icon: '❌',
			badgeClass: 'status-marked_for_deletion',
			isReadOnly: true,
			role: 'deleted'
		}
	],
	features: {
		create: true,
		save: true,
		post: true,
		copy: true,
		print: true,
		massOperations: true,
		hierarchy: false,
		delete: false,
		run: false,
		tabularSections: true
	},
	actions: [],
	fields: [
		{ name: 'number', title: 'Номер', type: 'string' },
		{ name: 'name', title: 'Содержание', type: 'string' }
	]
};

export default document;
