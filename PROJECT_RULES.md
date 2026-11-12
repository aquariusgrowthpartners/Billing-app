# Project Rules

## Deployment Verification

Canary Protocol (Mandatory): Run `node test-canary.js 3`. If it passes, testing is complete. If it fails, fix the code and re-run with 4 files. Continue increasing by 1 until it passes. Do NOT run the full 22-file suite unless explicitly requested by the user.

Desktop scroll verification at 1440×900, including native scrolling to the bottom, remains required before reporting a UI deployment successful.

UI Optimization: Every UI change must be verified at 1440x900 (desktop) and 390x844 (mobile) using the browser verification script. No horizontal overflow is allowed on mobile (document.scrollWidth === window.innerWidth).

## Protected UI

The `visualViewport` keyboard hook in `AskDundas.jsx` is protected. Do not remove or alter it while changing desktop layout behavior.

## Data and Schema

Do not make destructive schema changes without explicit approval. Do not use the billed `charge_amount` as the paid amount.

## Claims Views

Claims Views: No claims list should render data by default. A From/To date filter is mandatory. Render an empty state ('Select a date range to view claims') until both dates are selected.

## UI Animation Standards

UI Animation: All motion must use spring-like cubic-bezier curves (e.g., `cubic-bezier(0.16, 1, 0.3, 1)`), never plain `ease`/`ease-in-out` for interactive transitions. Animations may only animate `transform` and `opacity` (never `width`, `height`, or `top`), and animated elements should declare `will-change: transform`. Buttons scale to `0.97` on press; cards lift on hover; list cards fade in with a subtle stagger. Respect `prefers-reduced-motion`.

## Date Inputs and Home Layout

Premium Date Inputs: Every `input[type="date"]` is enhanced by the global `DateWheelProvider` and must never fall back to the browser's native date popover. Home's onboarding checklist is a collapsible left drawer on desktop and a slide-out drawer on mobile; Tasks render at the bottom of Home.

## Typography

Typography: Use the system font stack `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`, apply `letter-spacing: -0.01em` globally, keep body text at weight 400 and headings at weight 600, and never underline links.
