import { useEffect, useState } from 'react';
import { applyTheme, readTheme, themeChoices, themeStorageKey, type ThemeChoice } from './appearance.js';
const icons = {
  light: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  dark: 'M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z',
  system: 'M4 4h16v12H4V4Zm4 16h8m-4-4v4',
};
export function ThemeSwitcher() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => applyTheme(choice, media?.matches ?? false);
    apply(); media?.addEventListener('change', apply);
    try { window.localStorage.setItem(themeStorageKey, choice); } catch { /* Preference is optional in restricted browsers. */ }
    return () => media?.removeEventListener('change', apply);
  }, [choice]);
  return <div className="theme-switcher" role="group" aria-label="Color theme">
    {themeChoices.map(theme => <button key={theme} type="button" aria-label={`Use ${theme} theme`} aria-pressed={choice === theme}
      title={`${theme[0]!.toUpperCase()}${theme.slice(1)} theme`} onClick={() => setChoice(theme)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icons[theme]}/></svg><span>{theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark'}</span>
    </button>)}
  </div>;
}
