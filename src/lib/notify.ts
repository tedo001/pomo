/**
 * End-of-session feedback: a chime and a system notification.
 *
 * Both are best-effort. A blocked notification permission or an AudioContext the browser
 * refuses to start must never break the timer — the session already ended correctly in
 * the database, and this is only how the user finds out.
 */

let audioContext: AudioContext | null = null;

/**
 * Synthesised rather than a bundled audio file: no asset to ship, no decode step, and no
 * silent failure when a file 404s from a subpath deploy.
 */
export function playChime(volume: number): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioContext ??= new Ctor();
    // Browsers start contexts suspended until a gesture; the click that started the
    // timer counts, so resuming here is enough.
    void audioContext.resume();

    const now = audioContext.currentTime;
    const gain = audioContext.createGain();
    gain.connect(audioContext.destination);
    gain.gain.setValueAtTime(0.0001, now);

    // Two-note figure — a single beep reads as an error sound.
    [880, 1174.66].forEach((frequency, index) => {
      const at = now + index * 0.18;
      const osc = audioContext!.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, at);
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + 0.35);
    });

    const peak = Math.min(1, Math.max(0, volume)) * 0.3;
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
  } catch {
    // Audio is decoration; never let it surface as an app error.
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

export function notify(title: string, body: string): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: "pomo-session", icon: undefined });
  } catch {
    // Some browsers throw for non-persistent notifications; the in-app banner covers it.
  }
}

/** Live countdown in the tab title, so the timer is readable from another tab. */
export function setTitle(text: string): void {
  document.title = text;
}
