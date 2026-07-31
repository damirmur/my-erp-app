import type { Component } from 'svelte';

export interface FieldTypeModule {
	type: string;
	label: string;
	defaults: Record<string, unknown>;
	Configurator?: Component;
	FormField?: Component;
}
