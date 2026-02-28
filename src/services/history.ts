import type { DishAnalysis } from '../types';

/** Заглушка под будущее хранение истории (БД, кэш). */
export interface HistoryEntry {
  userId: number;
  analysis: DishAnalysis;
  at: Date;
}

const stub: HistoryEntry[] = [];

export function saveToHistory(userId: number, analysis: DishAnalysis): void {
  stub.push({ userId, analysis, at: new Date() });
}

export function getHistory(userId: number): HistoryEntry[] {
  return stub.filter((e) => e.userId === userId);
}
