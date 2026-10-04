<script lang="ts">
	import { page } from '$app/state';
	import { CSRF_FIELD, viewerFrom, type Viewer } from '$lib/components/shell/viewer.js';

	/**
	 * The session token every form sends back. Most callers render inside a cabinet, where the layout's `page.data`
	 * always carries the viewer; a page whose own load already typed a narrower `viewer` (the auth flows) passes it
	 * explicitly instead, including `null` for a visitor's form.
	 */
	let { viewer }: { viewer?: Viewer | null } = $props();

	const resolved = $derived(viewer !== undefined ? viewer : viewerFrom(page.data));
</script>

{#if resolved}
	<input type="hidden" name={CSRF_FIELD} value={resolved.csrfToken} />
{/if}
