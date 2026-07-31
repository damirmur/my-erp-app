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
			isReadOnly: true
		}
	],
	features: {
		hierarchy: true,
		copy: true,
		print: true,
		tabularSections: true
	},
	actions: [
		{ id: 'create', label: 'Создать', icon: '➕', type: 'list', variant: 'primary' },
		{ id: 'createFolder', label: 'Создать группу', icon: '📁', type: 'list' },
		{ id: 'moveUp', label: 'На уровень вверх', icon: '⬆️', type: 'list' },
		{ id: 'save', label: 'Записать', icon: '💾', type: 'form', disabled: (s) => s !== 'draft' },
		{
			id: 'markDelete',
			label: 'Пометить на удаление',
			icon: '❌',
			type: 'form',
			variant: 'text-danger',
			show: (s) => s !== 'marked_for_deletion'
		},
		{
			id: 'unmarkDelete',
			label: 'Снять пометку удаления',
			icon: '↩️',
			type: 'form',
			variant: 'text-success',
			show: (s) => s === 'marked_for_deletion'
		},
		{ id: 'copy', label: 'Копировать', icon: '📋', type: 'list' },
		{ id: 'copy', label: 'Копировать', icon: '📋', type: 'form' },
		{
			id: 'massDelete',
			label: 'Пометить на удаление',
			icon: '❌',
			type: 'list',
			variant: 'danger'
		},
		{ id: 'massRestore', label: 'Восстановить', icon: '↩️', type: 'list' },
		{ id: 'print', label: 'Печать', icon: '🖨️', type: 'list' },
		{ id: 'print', label: 'Печать', icon: '🖨️', type: 'form' }
	]
};

export default directory;
