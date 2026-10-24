"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getThemePreference, initTheme, setThemePreference, themeChangeEvent, type ThemePreference } from "../../../../../preview-src/uiTheme";

const glyph = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

// Light is the sun, dark the moon, and Auto the letter A (follows the system).
const icons: Record<ThemePreference, ReactNode> = {
  light: (
    <svg {...glyph}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </svg>
  ),
  dark: (
    <svg {...glyph}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  ),
  system: (
    <svg {...glyph}>
      <path d="m5 19 7-14 7 14M8.2 14h7.6" />
    </svg>
  ),
};
const choices: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeControl() {
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [systemLight, setSystemLight] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dispose = initTheme();
    const update = () => setTheme(getThemePreference());
    update();
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const follow = () => setSystemLight(media.matches);
    follow();
    media.addEventListener("change", follow);
    window.addEventListener(themeChangeEvent, update);
    return () => {
      dispose();
      media.removeEventListener("change", follow);
      window.removeEventListener(themeChangeEvent, update);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const press = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", press);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  // The button shows what the page looks like now (sun or moon), even while the choice is Auto.
  const shown = theme === "system" ? (systemLight ? "light" : "dark") : theme;
  const current = choices.find(choice => choice.value === theme) ?? choices[0];
  return (
    <div className="site-theme-control" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="site-theme-trigger"
        aria-label={`Color theme: ${current.label}`}
        title={`Theme: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {icons[shown]}
      </button>
      {open && (
        <div className="site-theme-menu" role="menu" aria-label="Color theme">
          {choices.map(choice => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice.value === theme}
              className="site-theme-option"
              onClick={() => {
                setThemePreference(choice.value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              {icons[choice.value]}
              <span>{choice.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
