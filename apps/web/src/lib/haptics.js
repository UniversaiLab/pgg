let enabled = true;

export const setHaptics = (on) => {
  enabled = on;
};

/** A short vibration where the platform allows it. Never throws. */
export function buzz(pattern = 12) {
  if (!enabled) return;
  try {
    globalThis.navigator?.vibrate?.(pattern);
  } catch {
    // some browsers throw without a user gesture; a missing buzz is not worth surfacing
  }
}
