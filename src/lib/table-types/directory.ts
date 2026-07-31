import type { TableTypeModule } from './type';

const directory: TableTypeModule = {
	type: 'directory',
	label: 'Справочник',
	statuses: [
		{ value: 'draft', label: 'Записан', icon: '⚪', badgeClass: 'status-draft', isReadOnly: false },
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
		post: false,
		copy: true,
		print: true,
		massOperations: true,
		hierarchy: true,
		delete: false,
		run: false,
		tabularSections: true
	},
	actions: [],
	fields: [
		{ name: 'number', title: 'Код', type: 'string' },
		{ name: 'name', title: 'Наименование', type: 'string' }
	]
};

export default directory;
