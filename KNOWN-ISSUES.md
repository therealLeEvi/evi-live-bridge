# Known issues and answers

Things people hit, what causes them, and what to do. Listed by what you would actually see.

Some of these are bugs with a fix coming. Several are EVI working as intended in a way that looks
like a fault — those say so plainly, because "it is meant to do that" is only a useful answer if it
comes with the reason.

**A bug entry stays here after it is fixed**, with the versions it affects, because the companion app
is a manual download and people run older ones for weeks. If a version is named, check yours before
assuming the entry is out of date.

If what you are seeing is not here, ask in **#help** on the [Discord](https://discord.gg/gFcEBHknVN).

---

## Setting up

### "Companion app out of date" on an app I just downloaded

**A bug in plugin 3.11.0 and earlier. Restart RuneLite and it goes away.**

If you pasted the wrong key when you first set up — the **Scanner key** instead of the **RuneLite
plugin key** — the plugin asked the app which version it spoke *before* it knew the key was wrong,
got refused, and remembered the refusal as "this app is ancient". Correcting the key fixes the
pairing but not that remembered answer, so the notice stays for the rest of the session.

Restarting the client clears it every time, so nothing is stuck. A fix is written — the version will
only be asked once the app has accepted the key — and it goes out with the next plugin update, which
arrives on its own through the Plugin Hub.

### It says my key is wrong, or no suggestion ever appears

**The app prints TWO keys and they are not interchangeable.**

- **RuneLite plugin key** → paste into EVI's sidebar in the client.
- **Scanner key** → paste into the dashboard at `http://127.0.0.1:51743/` in a browser.

They sit on adjacent lines in the app's window, so taking the wrong one is the easiest mistake there
is. EVI will now tell you which one it wanted, and the pairing box comes back so you can correct it.

If you deleted and recreated the app's `data` folder, every key it printed before is void — use the
new ones.

### macOS will not open it

macOS blocks programs downloaded from the internet. **Right-click `Start EVI Live.command` and choose
Open**, then Open again when asked. A plain double-click will not work the first time.

If it still will not start, or the window closes immediately, macOS is blocking the Node program
inside the folder rather than the launcher:

1. Open Terminal (press Command and the space bar, type Terminal, press Return).
2. Type `cd` and then a space. Do **not** press Return yet.
3. Drag the EVI folder from Finder onto that same Terminal window — its location fills in for you.
   If nothing appears, click the Terminal window once and drag again.
4. Press Return.
5. Type this, **including the dot at the end**, and press Return:
   ```
   xattr -dr com.apple.quarantine .
   ```
6. If it prints nothing, it worked. Double-click the launcher again.

If you get *"not enough arguments for option -d"*, the folder never arrived on the line — start again
at step 2. If macOS still refuses, open **System Settings → Privacy & Security** and scroll down:
there will be a line about EVI being blocked with an **Open Anyway** button.

### Nothing happens at all after installing the plugin

The plugin is only half of EVI. It needs the companion app running on the same computer —
[download it here](https://github.com/therealLeEvi/evi-live-bridge/releases/latest). Leave its window
open while you play; closing it stops EVI.

---

## While using it

### EVI has no suggestion

In rough order of likelihood:

1. **The companion app is not running.** Check its window is open, and that
   `http://127.0.0.1:51743/` loads in a browser.
2. **All eight Grand Exchange slots are in use.** EVI withholds buy suggestions entirely when there
   is nowhere to put one. This is by design and looks exactly like having nothing to say.
3. **Your minimum profit is higher than anything currently available.** EVI tells you what *is*
   within reach when this happens — read the message rather than the silence.
4. **Every candidate failed a check.** Margin too thin against the item's own tax, no buyers at the
   price, crashing right now, or too illiquid to get back out of.

### I am holding something and EVI will not mention selling it

**Mostly by design, with one real limit.**

Your holdings are now listed in the sidebar's advice area regardless of any setting — that is where
to look first.

For the single *suggestion* slot, a holding has to clear your minimum profit, the same bar a new
trade does. So a position worth less than your minimum stays out of the suggestion, and the richer
your settings, the more of your own stock that applies to. Setting **No minimum at all** reveals
everything immediately.

This was measured rather than guessed: lowering that bar made results worse, not better, so it stays
and the holdings list exists instead.

### A small instant buy never shows up in my history

If you bought **exactly one** of something, it filled immediately, and you paid *above* the market,
EVI treats it as a price check rather than a trade and does not record it.

That is deliberate — it is how EVI avoids inventing a fake losing flip every time someone probes a
price — and nothing observable separates a probe from a genuine one-unit purchase. There is no
setting for it.

### A suggested profit dropped, and it says "Buyers have moved on"

EVI checks what buyers have really been paying over the last twelve hours. A short burst of heavy
trading can leave that average describing a market that has already passed.

When the average sits well above what buyers are paying *now*, EVI recalculates the profit at today's
price and says so. **The trade is still offered** — buying at today's price may well be worth doing.
What changed is the number, not the pick.

### Two computers do not share my trades

**Correct, and not fixable — it is the reason EVI needs no privacy warning.**

`127.0.0.1` means "this computer", on every computer. Two installs are two completely separate apps:
separate journals, separate profit totals, separate keys. They cannot reach each other even
deliberately, because the app refuses any request that did not come from its own machine.

Pick one machine as the record keeper. To merge later, copy the `data` folder across **with both apps
stopped**.

### I sold something on another computer and this one still thinks I hold it

Each computer keeps its own records (see above), so the machine that did not watch the sale never
learns about it. The holding sits there for ever on the other one.

**Clear it from the dashboard, not the sidebar.** Open `http://127.0.0.1:51743/`, find the
**Still held** section, and close the entry. There is an undo if you misclick.

The sidebar's "I don't have this anymore" button only acts on the suggestion currently on screen, so
with several holdings you would have to wait for EVI to offer that one before you could dismiss it.
The dashboard lists them all at once.

### I updated the plugin but nothing seems different

The plugin updates itself through RuneLite. **The companion app does not** — it is a zip you
downloaded once. EVI tells you in the sidebar when it is behind, under the connection line.

When you replace it, **keep your `data` folder**: it is your trade history and your keys.

---

## Reporting something new

Post in **#bugs** on the Discord with the plugin version, the companion app release, what you
expected, what happened, and what the sidebar said. A screenshot is fine — crop your account name
out, EVI deliberately never records it.
