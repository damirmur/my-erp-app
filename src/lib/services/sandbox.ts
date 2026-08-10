import type { RunActionContext } from '$lib/services/actionRunner';

// Реестр расширений песочницы (контекста пользовательского кода «Выполнить»).
// Ядро (actionRunner/flowRunner/printer) НЕ знает про конкретные модули — оно
// строит контекст из универсальных хелперов + всех зарегистрированных здесь.
// Модули регистрируют свои хелперы через registerSandboxHelper (см. sandboxPlugins).
// Регистрация ленивая: get() вызывается на каждое построение контекста, но сами
// значения (например, динамический import модуля) загружаются только при первом
// обращении к хелперу в коде действия.

interface LazyHelper {
	get: () => unknown;
}

const helpers = new Map<string, LazyHelper>();

// Зарегистрировать хелпер песочницы. get() должен быть дешёвым и возвращать
// само значение хелпера (для модулей — функцию, лениво грузящую свой код).
export function registerSandboxHelper(name: string, get: () => unknown): void {
	helpers.set(name, { get });
}

// Построить контекст кода действия: универсальное ядро (base) + все
// зарегистрированные хелперы. Дубли имён — за base (модуль не переопределяет ядро).
export function sandboxContext(base: RunActionContext): RunActionContext {
	const extras: Record<string, unknown> = {};
	for (const [name, h] of helpers) {
		try {
			extras[name] = h.get();
		} catch {
			// битый хелпер не должен ломать контекст
		}
	}
	return { ...base, ...extras };
}
