import { writable } from 'svelte/store';
import type { TableTypeModule } from './type';

export const dynamicTypes = writable<Record<string, TableTypeModule>>({});
