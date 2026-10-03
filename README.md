# EVI Flipping Assistant bridge

The local half of **EVI Flipping Assistant**, a personal Old School RuneScape Grand Exchange
flip-tracking tool. This is a small Node.js server that runs on your own computer. The
[RuneLite plugin](https://github.com/therealLeEvi/evi-live-plugin) reports the Grand Exchange offers
you place yourself to this bridge, and asks it what to trade next.

Nothing here is a service. There is no account, no sign-up, and no server anywhere else: the bridge
listens on `127.0.0.1` only, stores its records in a folder next to itself, and the only outbound
requests it makes are to three public sources — the [OSRS Wiki real-time price
API](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices), the official Old School
RuneScape news feed, and the OSRS Wiki's item images, each fetched once and then served from your
own machine.

## Running it

Requires Node.js 24 or newer.

```
npm start
```

On first run it creates a `data/` folder holding two random keys and an append-only journal of the
offers it has been told about. The console prints both keys:

- the **RuneLite plugin key** — paste it into the plugin's sidebar to pair them;
- the **Scanner key** — paste it at `http://127.0.0.1:51743/` to open the browser dashboard.

`http://127.0.0.1:51743/setup` imports the trade history you already have, from the Exchange Logger
plugin or a CSV exported by any tracker, and turns EVI's local price record on or off. Both are
optional: EVI suggests trades without either.

Keep the `data/` folder private: it holds your keys and your trade history. It is never uploaded
anywhere.

```
npm test
```

runs the test suite.

## What it does

- **Keeps a journal of your own Grand Exchange offers**, exactly as the plugin observed them, and
  matches buys to sales automatically to work out realised profit after Grand Exchange tax.
- **Suggests what to trade next**, from your own trade history, from the whole item catalogue, or from
  the better of the two — your choice, in the plugin's *Suggest from* setting. Ranking uses what an
  item has been steadily worth over the last two weeks rather than its last couple of trade prints.
  Every suggestion is sized against your actual cash, the item's 4-hour buy limit, how much of it
  actually trades in the window you chose, and how long you want a trade to take.
- **Refuses trades whose edge is thinner than their own tax.** A margin the Grand Exchange's tax would
  eat is not offered, judged both on the quoted spread and on what buyers have actually been paying
  over the last 12 hours. The bar is the item's own tax, so it scales with the price, and tax-free
  items are exempt — measured over 335 hours of prices, that band is the safest of all. Choosing "no
  minimum at all" switches it off, for anyone who deliberately wants thin, high-volume flips.
- **Warns instead of hiding.** A sale that would lose money is still shown, with the loss and the
  break-even price, so the decision stays yours. When a check lacks data, it says so rather than
  inventing a number.

## Privacy and network behaviour

- Binds to `127.0.0.1` only, and rejects requests whose `Host` header is anything else.
- Two separate keys: the browser dashboard uses a cookie-based session, the plugin a bearer key.
  Cross-site requests are refused.
- The only upstream hosts contacted are `prices.runescape.wiki`, `secure.runescape.com` and
  `oldschool.runescape.wiki`, all public and all through a fixed allowlist of paths. There is no
  general-purpose proxy. The last is only for item pictures: each is fetched once, kept in
  `data/icons` and served from your own machine from then on, so the dashboard can show them
  without loading anything from another host.
- No account name, password, chat, or inventory content is collected. Accounts appear only as a
  salted pseudonym generated on your own machine. The plugin reads your coin count (to avoid
  suggesting trades you cannot afford) and, only if you switch that feature on, your inventory
  contents so idle stock can be suggested for sale.
- **The local price record is on by default.** It saves the Wiki's public hourly and five-minute price
  averages into `data/price-archive`, one request at a time, 2.5 seconds apart. Three of EVI's own
  safety checks read it and can say nothing without it: whether a price can realistically be bought
  again, whether an item is crashing, and whether a candidate duplicates something you already hold.
  On a fresh start it collects four days of past hours — about 96 requests over four minutes — then
  settles to roughly 13 an hour. It sends nothing about you, and you can switch it off at `/setup`.

`LOCAL-API.md` documents every endpoint the bridge exposes.

## Scope

This repository holds the bridge and the browser dashboard it serves. The dashboard is one HTML page
plus a few scripts in `scanner/`; the bridge serves them at `http://127.0.0.1:51743/` once unlocked.

Not published here: the backtester and the measurement tools used to decide what EVI's checks should
do. They read the same local journal and archive, and none of them are needed to run any of this.

## Licence

BSD 2-Clause. See `LICENSE`.
