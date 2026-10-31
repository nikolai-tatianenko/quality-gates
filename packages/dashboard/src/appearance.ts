export const themeChoices = ['light', 'dark', 'system'] as const;
export type ThemeChoice = typeof themeChoices[number];
export const themeStorageKey = 'qualitygate.theme';
export function readTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return themeChoices.includes(stored as ThemeChoice) ? stored as ThemeChoice : 'system';
  } catch { return 'system'; }
}
export function applyTheme(choice: ThemeChoice, darkSystem: boolean): void {
  document.documentElement.dataset.theme = choice === 'system' ? darkSystem ? 'dark' : 'light' : choice;
}
export function initializeTheme(): void {
  applyTheme(readTheme(), window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
}
