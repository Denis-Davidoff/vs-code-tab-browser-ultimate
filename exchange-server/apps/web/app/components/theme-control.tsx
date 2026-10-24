"use client";

import { useEffect, useState } from "react";
import { getThemePreference, initTheme, setThemePreference, themeChangeEvent, type ThemePreference } from "../../../../../preview-src/uiTheme";

export function ThemeControl() {
  const [theme, setTheme] = useState<ThemePreference>("system");
  useEffect(() => {
    const dispose = initTheme();
    const update = () => setTheme(getThemePreference());
    update();
    window.addEventListener(themeChangeEvent, update);
    return () => {
      dispose();
      window.removeEventListener(themeChangeEvent, update);
    };
  }, []);
  return (
    <label className="site-theme-control">
      <span>Theme</span>
      <select aria-label="Color theme" value={theme} onChange={event => setThemePreference(event.target.value as ThemePreference)}>
        <option value="system">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
