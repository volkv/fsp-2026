// Applies the saved or system color mode before the first paint, so a page load never flashes the other theme.
// A same-origin file rather than an inline script: the page CSP allows scripts only from 'self'.
// Mirrors setInitialMode of mode-watcher: same storage key and values ('light' | 'dark' | 'system').
(function () {
	var root = document.documentElement;
	var mode = 'system';
	try {
		mode = localStorage.getItem('mode-watcher-mode') || 'system';
	} catch {
		// Storage is unavailable (private mode, blocked cookies): follow the system.
	}
	if (mode !== 'light' && mode !== 'dark') mode = 'system';
	var dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
	// The chosen mode itself, for the theme toggle icon: the server cannot know it and renders all three.
	root.dataset.themeMode = mode;
	root.classList.toggle('dark', dark);
	root.style.colorScheme = dark ? 'dark' : 'light';
})();
