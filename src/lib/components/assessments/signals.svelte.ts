/**
 * Signals of an attempt the page reports with an answer or a submission: time on the page, pastes into the answer and
 * how often the page lost focus. They go to the attempt journal for a person who reviews it; nothing is decided by
 * them, and they are not a detection of generated code.
 */
export class AttemptSignals {
	#startedAt = Date.now();
	pasteCount = $state(0);
	pastedChars = $state(0);
	blurCount = $state(0);

	/** Listens to the page while the component that owns it is mounted; returns the cleanup. */
	watchPage(): () => void {
		const onBlur = () => {
			this.blurCount++;
		};
		window.addEventListener('blur', onBlur);
		return () => {
			window.removeEventListener('blur', onBlur);
		};
	}

	recordPaste(event: ClipboardEvent): void {
		this.pasteCount++;
		this.pastedChars += event.clipboardData?.getData('text/plain').length ?? 0;
	}

	serialize(): string {
		return JSON.stringify({
			elapsedMs: Math.min(86_400_000, Date.now() - this.#startedAt),
			pasteCount: this.pasteCount,
			pastedChars: this.pastedChars,
			blurCount: this.blurCount
		});
	}

	/** A new question starts its own measurement. */
	reset(): void {
		this.#startedAt = Date.now();
		this.pasteCount = 0;
		this.pastedChars = 0;
		this.blurCount = 0;
	}
}
