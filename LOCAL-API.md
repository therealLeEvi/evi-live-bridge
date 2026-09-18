# Local API v1

Base URL: `http://127.0.0.1:51743`. No LAN binding, CORS, arbitrary upstream URLs, or game-control endpoints.

| Endpoint | Access | Result |
| --- | --- | --- |
| `POST /api/unlock` | Exact browser Origin; JSON `{ "key": "SCANNER_KEY" }` | Sets local HttpOnly, SameSite=Strict cookie |
| `GET /api/state` | Scanner cookie | `sessions`, `active`, `occupied`, `completed`, `flips`, `dataHealth` (see below) |
| `POST /api/events` | `Authorization: Bearer PLUGIN_KEY` | Validates and stores a passive snapshot |
| `GET /api/suggestion?minProfit=&blocklist=&risk=&openItemId=` | `Authorization: Bearer PLUGIN_KEY` | `{ "suggestion": {...} \| null, "openItemPrice": {...} \| null }` -- `suggestion` ranked from this account's own reviewed flips only; `openItemPrice` a plain live-market price for whatever item ID `openItemId` names, independent of ranking (see below). This is not the full parameter list -- see the "Optional query parameters" section below for the rest (`includeMarket`, `duration`, `cash`, `exclude`, `holdItemId`/`holdQty`/`holdName`). |
| `POST /api/flips` | Cookie, exact Origin, `X-EVI-UI: 1` | Reviews a matched pair using `{buyId,sellId,netProceeds}` |
| `POST /api/logout` | Cookie, exact Origin, `X-EVI-UI: 1` | Clears browser authentication cookie |
| `GET /api/market/mapping`, `/latest`, `/5m`, `/1h` | Cookie | Fixed public price API proxy; all paths start `/api/market/` |
| `GET /api/market/timeseries?id=4151&timestep=1h` | Cookie | Fixed public item time series |
| `GET /api/news` | Cookie | Official OSRS RSS |
| `GET /api/news-items` | Cookie | Tradeable items each recent news post connects to, with the chain of wiki pages linking them (`bridge/newsChain.mjs`). Answered from a per-post cache immediately; the wiki walk runs in the background, one request at a time, at most twice a day. A connection, never a price prediction. |

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
- `slots` — `itemId:remainingQty` pairs for every still-in-progress GE offer, e.g. `slots=4151:300,12:50`; populates the `slotPrices` and `slotFill` response fields so the plugin can say when an offer's own price has drifted from the market or is running slower than the target duration. Terminal-but-uncollected offers are deliberately left out — there is nothing left to cancel or relist.
- `freeSlots`, `collectable` — how much room the Grand Exchange has: slots that are genuinely empty, and slots holding a finished offer that has not been collected. Old School allows eight simultaneous offers, so when `freeSlots=0&collectable=0` the bridge skips *every* ranking tier and returns `suggestion: null` — with nowhere to place an offer, nothing it could rank can be acted on. A finished, uncollected offer is **not** treated as no room (collecting is one click), so ranking continues and the suggestion carries a note saying how many can be collected. Either parameter missing, negative, above 8 or non-numeric reads as "not known yet" and constrains nothing — see `slotCapacity` in `bridge/suggestions.mjs`.
- `members` — `1` or `0` for the kind of world the player is logged into, so a members-only item is never suggested on a free-to-play world. Unset means unknown and filters nothing.
- `heldPositions` — which of the item IDs this bridge named in `slots.positionItems` the plugin actually found in the player's inventory. The plugin only ever echoes IDs the bridge named itself, so no other inventory contents leave the client. Sent even when empty once a check has happened, because "checked, found none" is what exposes a stale position. Used for the sell-slot reserve (only confirmed stock owes an exit slot) and the scanner's data-health line. Absent means unchecked, which reserves nothing.
- `risk` — defaults to `low` when absent (it was `medium`): replayed over 90 days, Medium did no better than a random eligible pick. The plugin sends `risk=medium` explicitly.
- `profile`, `stackShare`, `cushion`, `forecast`, `onForecast`, `includeInventory`/`inventory`, `holdBuyId`, `holdBuyPrice`, `account` — the remaining settings- and session-derived parameters; each is read once at the top of the `/api/suggestion` handler in `bridge/server.mjs`, where what it does is documented next to the code that does it.

Two response fields accompany `suggestion` and `openItemPrice` beyond `slotPrices`/`slotFill`:

- `slots` — `{free, collectable, full, tight}`, echoing back what the capacity parameters above were understood to mean. `full` is what suppressed ranking; `tight` means every slot is occupied but something can be collected. `free`/`collectable` are `null` when unknown.
- `slots.positionItems` — the item IDs this account's journal believes are still held, for the plugin to confirm against its inventory (see `heldPositions`).
- `heldBack` — up to three candidates set aside for a stated reason (currently: moving with an item already held, see `bridge/correlation.mjs`), so a missing suggestion can be explained rather than blamed on settings.
- On a buy `suggestion`: `sellSupport` when its margin disappears at the price buyers actually paid over the last 12 hours (`sellPriceSupport`, with a warning at the front of `reasoning`), and `fillOutlook` with the measured buy/sell fill rates for its price pattern. Neither ever blocks a suggestion.
- On `openItemPrice`: when the open item is one the player holds, `action: "sell"`, `breakEvenPrice` and `lossIfSoldNow`, using the same arithmetic as the holding reminder, so the offer prompt can warn before a sale loses GP.

`GET /api/state` additionally returns:

- `occupied` — every offer in one of the eight slots right now, including finished ones not yet collected (unlike `active`), since an uncollected offer still holds its slot.
- `dataHealth` — what the headline profit total does not include, counted exactly and never estimated: `unmatchedSales` / `unmatchedGross` (sales with no recorded purchase, and the GP they reported), `openPositions` / `openCost` (purchases not yet sold, at their own recorded unit cost), and, when the plugin checked within the last ten minutes, `inventoryCheck.seenInInventory` of `inventoryCheck.positions` for that account.

`POST /api/price-archive` also accepts `{"fiveMinute": {"enabled": true, "backfillDays": 0-90}}` for an optional five-minute archive alongside the hourly one, and its status reports each stream under `steps["1h"]` / `steps["5m"]`, including how many buckets remain to fetch. Both are off by default.
- `relistAdvice` — one hedged sentence per sell offer that has been sitting unsold longer than a quarter of the target duration: how long it has waited, what the market is now, and whether relisting there still clears the stock's break-even after tax. Built entirely from the bridge's own journal, so the plugin sends nothing extra for it. It never suggests a price below break-even, and says so plainly when the market has fallen under it — see `bridge/relist.mjs`.
