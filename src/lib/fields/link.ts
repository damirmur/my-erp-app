import type { FieldTypeModule } from './field';
import LinkConfig from './LinkConfig.svelte';
import LinkField from './LinkField.svelte';

const linkField: FieldTypeModule = {
	type: 'link',
	label: 'Ссылка на справочник',
	defaults: {},
	Configurator: LinkConfig,
	FormField: LinkField
};

export default linkField;
