# Project Rules

## Deployment Verification

Every deployment requires:

1. A passing Canary test (`node test-canary.js 3`).
2. A full RA regression test (`node test-all-ras.js`).
3. A desktop scroll verification at 1440×900, including native scrolling to the bottom.

No deployment may be reported successful without all three checks.

## Protected UI

The `visualViewport` keyboard hook in `AskDundas.jsx` is protected. Do not remove or alter it while changing desktop layout behavior.

## Data and Schema

Do not make destructive schema changes without explicit approval. Do not use the billed `charge_amount` as the paid amount.
