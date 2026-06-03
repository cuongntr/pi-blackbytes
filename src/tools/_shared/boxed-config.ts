let boxedToolCallsEnabled = true;

export function setBoxedToolCallsEnabled(enabled: boolean): void {
  boxedToolCallsEnabled = enabled;
}

export function isBoxedToolCallsEnabled(): boolean {
  return boxedToolCallsEnabled;
}

/** Reset to default (true) for session restart. Used by resetSessionRuntimeState(). */
export function _resetBoxedToolCallsEnabled(): void {
  boxedToolCallsEnabled = true;
}
