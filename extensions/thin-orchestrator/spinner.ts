/**
 * Animated braille spinner for running indicators.
 *
 * The frame/timer record is persisted in the tool's renderer state (the
 * stable `context.state` object that survives every re-render of the tool
 * row), so the animation continues seamlessly across re-renders and
 * expanded/collapsed toggles. A single ticker drives all running glyphs for
 * one tool execution; terminal-state icons (✓/✗/○) stay static.
 */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 80;

export interface SpinnerState {
	frame: number;
	timer: ReturnType<typeof setInterval> | null;
}

export type SpinnerRendererState = { spinner?: SpinnerState };

/** Stop the spinner ticker persisted in renderer state (idempotent). */
export function stopSpinner(state: SpinnerRendererState | undefined): void {
	const s = state?.spinner;
	if (!s) return;
	if (s.timer !== null) {
		clearInterval(s.timer);
		s.timer = null;
	}
	// Remove the record so a later `spinningFrame` call restarts cleanly.
	delete state.spinner;
}

/**
 * Return the current spinner frame, starting the ticker on first use.
 * Each tick advances the frame and calls `invalidate()` to force a
 * tool-component re-render. Timer is unref'd so headless runs can exit.
 */
export function spinningFrame(state: SpinnerRendererState | undefined, invalidate: () => void): string {
	if (!state) return SPINNER_FRAMES[0];

	let s = state.spinner;
	if (s) {
		return SPINNER_FRAMES[s.frame % SPINNER_FRAMES.length];
	}

	s = { frame: 0, timer: null };
	state.spinner = s;
	s.timer = setInterval(() => {
		s.frame = (s.frame + 1) % SPINNER_FRAMES.length;
		invalidate();
	}, SPINNER_INTERVAL_MS);
	// Node `Timeout` has `unref`; keep headless runs free to exit.
	(s.timer as unknown as { unref?: () => void })?.unref?.();
	return SPINNER_FRAMES[0];
}
