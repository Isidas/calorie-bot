import type { DishAnalysis } from '../types';

export interface ClarificationQuestion {
  id: string;
  text: string;
  options: { label: string; value: string }[];
}

export interface DialogState {
  userId: number;
  baseAnalysis: DishAnalysis;
  question: ClarificationQuestion;
  startedAt: number;
}

const dialogs = new Map<number, DialogState>();

export function setDialog(userId: number, state: DialogState): void {
  dialogs.set(userId, state);
}

export function getDialog(userId: number): DialogState | undefined {
  return dialogs.get(userId);
}

export function clearDialog(userId: number): void {
  dialogs.delete(userId);
}
