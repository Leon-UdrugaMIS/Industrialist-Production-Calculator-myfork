export const GAME_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type GameMonth = (typeof GAME_MONTHS)[number];

export const DEFAULT_GAME_MONTH: GameMonth = 'January';

export function isGameMonth(value: unknown): value is GameMonth {
  return typeof value === 'string' && (GAME_MONTHS as readonly string[]).includes(value);
}

export const GAME_DIFFICULTIES = [
  'normal',
  'hard',
  'impossible',
  'impossible2',
  'sandbox',
  'sandbox_plus',
] as const;

export type GameDifficulty = (typeof GAME_DIFFICULTIES)[number];

export function isGameDifficulty(value: unknown): value is GameDifficulty {
  return typeof value === 'string' && (GAME_DIFFICULTIES as readonly string[]).includes(value);
}
