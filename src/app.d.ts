// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

// Vite `?url` imports (например, воркер pdfjs-dist)
declare module '*?url' {
	const src: string;
	export default src;
}

export {};
