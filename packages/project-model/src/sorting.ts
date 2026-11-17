export function sortedBy<T>(items: T[], key: (item: T) => number): T[] {
  for (let i = 1; i < items.length; i++) {
    if (key(items[i]!) < key(items[i - 1]!))
      return [...items].sort((a, b) => key(a) - key(b));
  }

  return items;
}

export const sortedByStart = <T extends { start: number }>(items: T[]): T[] =>
  sortedBy(items, (it) => it.start);

export const sortedByTime = <T extends { t: number }>(items: T[]): T[] =>
  sortedBy(items, (it) => it.t);
