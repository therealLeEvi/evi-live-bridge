# Local API v1

Base URL: `http://127.0.0.1:51743`. No LAN binding, CORS, arbitrary upstream URLs, or game-control endpoints.

| Endpoint | Access | Result |
| --- | --- | --- |
| `POST /api/unlock` | Exact browser Origin; JSON `{ "key": "SCANNER_KEY" }` | Sets local HttpOnly, SameSite=Strict cookie |
| `GET /api/state` | Scanner cookie | `sessions`, `active`, `completed`, `flips` |
| `POST /api/events` | `Authorization: Bearer PLUGIN_KEY` | Validates and stores a passive snapshot |
| `GET /api/suggestion?minProfit=&blocklist=&risk=&openItemId=` | `Authorization: Bearer PLUGIN_KEY` | `{ "suggestion": {...} \| null, "openItemPrice": {...} \| null }` -- `suggestion` ranked from this account's own reviewed flips only; `openItemPrice` a plain live-market price for whatever item ID `openItemId` names, independent of ranking (see below). This is not the full parameter list -- see the "Optional query parameters" section below for the rest (`includeMarket`, `duration`, `cash`, `exclude`, `holdItemId`/`holdQty`/`holdName`). |
| `POST /api/flips` | Cookie, exact Origin, `X-EVI-UI: 1` | Reviews a matched pair using `{buyId,sellId,netProceeds}` |
| `POST /api/logout` | Cookie, exact Origin, `X-EVI-UI: 1` | Clears browser authentication cookie |
| `GET /api/market/mapping`, `/latest`, `/5m`, `/1h` | Cookie | Fixed public price API proxy; all paths start `/api/market/` |
| `GET /api/market/timeseries?id=4151&timestep=1h` | Cookie | Fixed public item time series |
| `GET /api/news` | Cookie | Official OSRS RSS |

Example event body (the real plugin sends eight unique slots while logged in):

```json
{
  "version": 1,
  "session": "random-session-uuid",
  "account": "salted-account-pseudonym",
  "seq": 1,
  "ts": 1789300000000,
  "loggedIn": true,
  "offers": [{
    "slot": 0,
    "offerId": "random-offer-uuid",
    "state": "BUYING",
    "itemId": 4151,
    "name": "Abyssal whip",
    "price": 1000000,
    "total": 1,
    "filled": 0,
    "spent": 0,
    "knownStart": true
  }]
}
```

This example illustrates one slot; supply the other seven slots for a valid logged-in packet. Logged-out packets have an empty offers array. Sequence numbers increase within a session; retries reuse the identical packet and number. Offer IDs survive partial fills and terminal transitions, then change for a new offer. `knownStart` is true only when an empty slot was observed before a new zero-filled offer. A baseline cannot be promoted later. `spent` is the RuneLite cumulative API counter, not a promise of after-tax proceeds.

The service rejects malformed fields, counter regressions, identity reuse, incorrect keys, and cross-origin browser access. Repeated sequence numbers are acknowledged without duplicating records. Full implementation and validation rules are in `bridge/store.mjs` and `bridge/server.mjs`.

Example `GET /api/suggestion` response:

```json
{
  "suggestion": {
    "itemId": 13190,
    "name": "Fire rune",
    "action": "buy",
    "quantity": 5000,
    "buyPrice": 4,
    "sellPrice": 5,
    "source": "personal",
    "reasoning": "You've flipped this 6 times with a 83% win rate and ~12,400 GP average profit. Suggested quantity matches your typical size (5000); buy near 4 gp, aim to sell near 5 gp."
  }
}
```

`suggestion` is `null` when there is no eligible item: no reviewed flip history yet, no item with a winning track record, or no item currently showing a positive margin after estimated tax. `buyPrice` and `sellPrice` are always both present together (the current Wiki low and high for the item); the plugin shows/fills whichever one matches the GE prompt you actually have open, not just whichever direction `action` names. `action` is currently always `"buy"` and describes the suggested next move if you don't yet hold the item — it does not gate which price the plugin uses. Ranking (`bridge/suggestions.mjs`) uses only this account's own confirmed flips (`Store.state().flips`) combined with the live OSRS Wiki price feed — never a shared pool across users. `source` is currently always `"personal"`; a future `"scanner"` source (the fuller market-wide ranking already used by "Suggested GE Slots" in the scanner UI) is a separate, not-yet-built tier.

`openItemPrice` is a separate, additive field (`bridge/suggestions.mjs`'s `lookupItemPrice`): a plain `{itemId, buyPrice, sellPrice}` (no `name`/`action`/`quantity`/`source`/`reasoning`) for whatever item ID the `openItemId` query parameter names, straight from the same already-fetched Wiki `/latest` data, with no ranking, no flip-history requirement, and no volume/liquidity/affordability filtering at all. `null` when `openItemId` is missing/invalid or that item has no usable live price right now. This is what lets the plugin's hint text and fill hotkey work for whatever item you're actually buying or selling, not only the single item `suggestion` names — see `GEOffer.resolveOpenSuggestion` in the plugin source.

Optional query parameters, all built by the plugin from its own local config and session state and sent on every poll (see the plugin's **Suggestion Settings** in section 5 of the README):

- `minProfit` — a non-negative integer; a candidate whose predicted profit (current buy/sell margin × suggested quantity) is below this is skipped. Missing, non-numeric, or negative values are treated as `0` (no filter).
- `blocklist` — a comma-separated list of item IDs to exclude from ranking entirely, e.g. `blocklist=4151,995`. Missing or malformed entries are ignored.
- `risk` — one of `low`, `medium`, `high`; anything else (including a missing value) falls back to `medium`, the original unchanged ranking balance. See section 5 for what each tier actually changes — it's an approximation from this account's own win-rate history, not real market volatility.
- `includeMarket` — `1` to let `suggestion` fall back to a market-wide pick (ranked by current margin and trading volume across the whole item catalogue) when nothing in your own reviewed history is currently eligible. Off (unset) by default.
- `duration` — a target trade duration in minutes; a candidate too slow-moving even for one unit within that window (per the Wiki `/1h` recent-volume data) is skipped, and one that's only realistic at a smaller quantity is sized down. Unset means no preference.
- `cash` — the player's actual current cash stack (read from inventory coins by the plugin); caps/re-ranks `suggestion` to what's actually affordable. Unset when not yet known.
- `exclude` — a comma-separated list of item IDs to leave out of `suggestion`'s ranking for this poll only (active GE slots, manually skipped items) — session-only, distinct from the permanent `blocklist`.
- `holdItemId`, `holdQty`, `holdName` — an item the plugin has observed the player already bought and collected this session but not yet resold; when present and priced, takes priority over the normal ranking for `suggestion` (see `computeHoldingSuggestion`).
- `openItemId` — the item ID currently selected in an open GE offer (buy or sell), regardless of whether it has any relation to `suggestion` at all; populates the separate `openItemPrice` field described above.
