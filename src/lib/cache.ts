/**
 * Short-lived copies of account data that Home shows on every visit (the profile and the Vitra cosmetics
 * status), so opening Home doesn't ask Mojang and api.xan.gripe each time. Anything that changes that
 * data (skin, cape, Vitra cape, name) calls `forgetAccountData()`, so Home shows the change at once.
 */
type Entry = { key: string; at: number; value: unknown };

const entries = new Map<string, Entry>();

export function cached<T>(name: string, key: string, maxAgeMs: number): T | undefined {
  const e = entries.get(name);
  return e && e.key === key && Date.now() - e.at < maxAgeMs ? (e.value as T) : undefined;
}

export function remember<T>(name: string, key: string, value: T): void {
  entries.set(name, { key, at: Date.now(), value });
}

export function forgetAccountData(): void {
  entries.clear();
}
