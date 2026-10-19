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
