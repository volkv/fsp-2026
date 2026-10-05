// Container images of the documentation build, pinned by tag and digest. pandoc/core rather than pandoc/latex: the PDF is
// printed by Chromium from pandoc's HTML, so the LaTeX toolchain (gigabytes, no Cyrillic without extra fonts) is not needed.
export const PANDOC_IMAGE =
	'pandoc/core:3.11.0.0@sha256:62518bfb6833705dc90a1634d8d879299bd820b3f74ad3b32fba8b618452553a';
export const MERMAID_IMAGE =
	'minlag/mermaid-cli:12.0.1@sha256:2c5d27365df71da06c288beebe531ea3637cf9b422b871239a3b016233591d24';
