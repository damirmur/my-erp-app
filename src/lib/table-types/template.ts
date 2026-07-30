import type { TableTypeModule } from './type';

const template: TableTypeModule = {
    type: 'template',
    label: 'Шаблон',
    statuses: [
        { value: 'draft', label: 'Черновик', icon: '⚪', badgeClass: 'status-draft', isReadOnly: false }
    ],
    features: {
        hierarchy: false,
        copy: false,
        print: false,
        tabularSections: false
    },
    actions: [
        { id: 'save', label: 'Записать', icon: '💾', type: 'form' }
    ]
};

export default template;
