// Reading of submitted forms, shared by the request handlers and by the code they call outside of a request.

/** A text field of a form; a missing field or a file reads as an empty string. */
export function formText(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}
