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
