/*
 * theme.js — light/dark toggle for the WPZ Studio site.
 *
 * Follows the dark-light-theme skill:
 *   - `<html data-theme="light|dark">` is the single source of truth.
 *   - Loaded synchronously in <head> after the stylesheet so the palette is
 *     applied before <body> paints (no flash of the wrong theme, no inline JS).
 *   - Preference: localStorage.appTheme -> prefers-color-scheme -> light.
 *   - The OS is followed live only while no explicit choice has been stored.
 *   - i18n tooltip works even before the i18n module loads (zh/en fallback).
 *   - Dispatches `themeChanged` (+ legacy `wpz:theme-change` alias).
 *
 * The `theme-switching` class freezes transitions for the one frame in which
 * the palette flips, so the 73 product cards do not all tween their shadows
 * and the backdrop-filter layers do not re-blur on every frame.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "appTheme";
  var LEGACY_KEY = "wpz-theme";
  var DARK_QUERY = "(prefers-color-scheme: dark)";
  var root = document.documentElement;
  var restoreFrame = 0;

  // Bilingual fallback: the tooltip must be correct before i18n initialises.
  var LABELS = {
    zh: { toDark: "切换到深色主题", toLight: "切换到浅色主题" },
    en: { toDark: "Switch to dark theme", toLight: "Switch to light theme" }
  };

  function readPreference() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved !== "light" && saved !== "dark") {
        // One-time migration from the key used by the old two-button switcher
        // so returning visitors keep their choice.
        var legacy = window.localStorage.getItem(LEGACY_KEY);
        if (legacy === "light" || legacy === "dark") {
          saved = legacy;
          window.localStorage.setItem(STORAGE_KEY, saved);
          window.localStorage.removeItem(LEGACY_KEY);
        }
      }
      return saved === "light" || saved === "dark" ? saved : null;
    } catch (e) {
      return null;
    }
  }

  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia(DARK_QUERY).matches);
  }

  function resolveTheme() {
    var saved = readPreference();
    return saved || (prefersDark() ? "dark" : "light");
  }

  function currentLang() {
    var lang = root.getAttribute("lang") || (navigator.language || "en");
    return /^zh/i.test(lang) ? "zh" : "en";
  }

  /* ------------------------------------------------------------------
   * BOOT — runs before <body> paints.
   * ------------------------------------------------------------------ */
  root.setAttribute("data-theme", resolveTheme());

  /* ------------------------------------------------------------------
   * Progressive behaviour — waits for the DOM so the button can be synced.
   * ------------------------------------------------------------------ */
  function renderToggle(theme) {
    var button = document.querySelector(".theme-toggle");
    if (!button) {
      return;
    }
    var goDark = theme !== "dark";
    var label = LABELS[currentLang()][goDark ? "toDark" : "toLight"];
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  }

  function paint(theme, persist) {
    if (root.getAttribute("data-theme") === theme) {
      renderToggle(theme);
      return;
    }

    if (restoreFrame) {
      window.cancelAnimationFrame(restoreFrame);
    }
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", theme);

    if (persist) {
      try {
        window.localStorage.setItem(STORAGE_KEY, theme);
        window.localStorage.removeItem(LEGACY_KEY);
      } catch (e) {}
    }
    renderToggle(theme);

    var restoreTransitions = function () {
      restoreFrame = 0;
      root.classList.remove("theme-switching");
    };
    if (window.requestAnimationFrame) {
      restoreFrame = window.requestAnimationFrame(function () {
        restoreFrame = window.requestAnimationFrame(restoreTransitions);
      });
    } else {
      restoreTransitions();
    }

    var detail = { theme: theme, source: persist ? "toggle" : "system" };
    window.dispatchEvent(new CustomEvent("themeChanged", { detail: detail }));
    window.dispatchEvent(new CustomEvent("wpz:theme-change", { detail: detail }));
  }

  function init() {
    var button = document.querySelector(".theme-toggle");
    if (button) {
      button.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        paint(next, true);
      });
    }
    renderToggle(root.getAttribute("data-theme") || resolveTheme());

    // Follow the OS only while the visitor has not chosen a theme explicitly.
    if (window.matchMedia) {
      var query = window.matchMedia(DARK_QUERY);
      var onSystemChange = function () {
        if (!readPreference()) {
          paint(prefersDark() ? "dark" : "light", false);
        }
      };
      if (query.addEventListener) {
        query.addEventListener("change", onSystemChange);
      } else if (query.addListener) {
        query.addListener(onSystemChange);
      }
    }

    // Re-render the tooltip when the site language changes.
    ["wpz:lang-change", "languageChanged"].forEach(function (name) {
      window.addEventListener(name, function () {
        renderToggle(root.getAttribute("data-theme") || resolveTheme());
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
