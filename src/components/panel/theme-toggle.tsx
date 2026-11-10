"use client";

import { useEffect, useState } from "react";

import { IconMoon, IconSun } from "./icons";

/** Açık/koyu tema. Seçim `localStorage`'a yazılır; ilk boyama kök layout'taki script ile yapılır. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    setTheme(current);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("panel-theme", next);
    } catch {
      /* gizli mod: sessizce yut */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç"}
      title={theme === "dark" ? "Açık tema" : "Koyu tema"}
      className="btn btn-ghost h-10 w-10 justify-center rounded-lg p-0"
    >
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
