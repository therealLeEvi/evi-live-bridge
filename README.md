# EVI Live bridge

The local half of **EVI Live (Local)**, a personal Old School RuneScape Grand Exchange
flip-tracking tool. This is a small Node.js server that runs on your own computer. The
[RuneLite plugin](https://github.com/therealLeEvi/evi-live-plugin) reports the Grand Exchange offers
you place yourself to this bridge, and asks it what to trade next.

Nothing here is a service. There is no account, no sign-up, and no server anywhere else: the bridge
listens on `127.0.0.1` only, stores its records in a folder next to itself, and the only outbound
requests it makes are to two public sources — the [OSRS Wiki real-time price
API](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices) and the official Old School
RuneScape news feed.

## Running it

Requires Node.js 24 or newer.

```
npm start
```

On first run it creates a `data/` folder holding two random keys and an append-only journal of the
offers it has been told about. The console prints a **RuneLite plugin key**; paste that into the
plugin's sidebar to pair them. Keep the `data/` folder private: it holds your keys and your trade
history. It is never uploaded anywhere.

```
npm test
```

runs the test suite (158 tests as of this writing).

## What it does

- **Keeps a journal of your own Grand Exchange offers**, exactly as the plugin observed them, and
  matches buys to sales automatically to work out realised profit after Grand Exchange tax.
- **Suggests what to trade next**, ranked from your own reviewed trade history first, and optionally
  from the whole item catalogue when your history has nothing eligible. Every suggestion is sized
  against your actual cash, the item's 4-hour buy limit, and how long you want a trade to take.
- **Warns instead of hiding.** A sale that would lose money is still shown, with the loss and the
  break-even price, so the decision stays yours. When a check lacks data, it says so rather than
  inventing a number.

## Privacy and network behaviour

- Binds to `127.0.0.1` only, and rejects requests whose `Host` header is anything else.
- Two separate keys: the browser dashboard uses a cookie-based session, the plugin a bearer key.
  Cross-site requests are refused.
- The only upstream hosts contacted are `prices.runescape.wiki` and `secure.runescape.com`, both
  public and both through a fixed allowlist of paths. There is no general-purpose proxy.
- No account name, password, chat, or inventory content is collected. Accounts appear only as a
  salted pseudonym generated on your own machine. The plugin reads your coin count (to avoid
  suggesting trades you cannot afford) and, only if you switch that feature on, your inventory
  contents so idle stock can be suggested for sale.
- The optional price archive (off by default) saves the Wiki's public hourly price averages locally
  for backtesting, one request at a time.

`LOCAL-API.md` documents every endpoint the bridge exposes.

## Scope

This repository is the bridge alone. The browser dashboard that reviews trades and shows profit over
time is not published here.

## Licence

BSD 2-Clause. See `LICENSE`.
