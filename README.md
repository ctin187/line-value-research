# Line Value Research

A live NFL / College Football line scanner, value-identification engine and
parlay builder. It pulls odds from [The Odds API](https://the-odds-api.com),
de-vigs them into fair probabilities, grades every book's price against that
number, and flags line movement, sharp/public disagreement and inflated
favourites — then helps you size a parlay against your own bankroll.

Node 20+. **Zero runtime dependencies** — `npm install` is not required to run it.

```bash
cp .env.example .env      # add your free Odds API key (optional)
npm start                 # http://127.0.0.1:3000
```

Without a key it starts anyway on a **simulated feed**, so you can see the whole
tool working before spending a single API credit.

```bash
npm start          # web UI
npm run demo       # force the simulated feed even with a key present
npm run scan       # one-shot terminal scan
npm test           # 72 tests, no network
```

---

## What it actually does

### The board

Three panels: research filters on the left, the games grid in the middle, the
parlay slip on the right. Every selection shows a **fair probability**, then
every book's price graded against it — green at 2%+ edge, yellow at 1–2%, grey
below that, red when the price is worse than fair.

### Where "fair" comes from

This is the part that matters, so it is worth being precise about.

A book's posted price includes its hold, so `-110/-110` is not a 50/50 market —
it is a 52.4/52.4 market that adds up to 104.8%. **De-vigging** normalises those
two numbers back to 100%, which recovers what the book actually thinks. That
de-vigged number, taken from a sharp book, is the best free estimate of true
probability that exists.

So for each selection the engine:

1. de-vigs **every** book's two-way market for that selection,
2. weights them toward the sharp books (Pinnacle 3×, other sharp books 2×,
   public books 1×) and averages,
3. **excludes the book being graded**, so no book ever grades its own price —
   otherwise every price would show a 0% edge,
4. requires at least two books before it will print a fair number at all.

`Edge % = fair probability − implied probability`, in percentage points.

**You can override it.** Type your own number into the "Your probability %" box
on any selection and every edge and EV recomputes against your figure
immediately. That is what the tool is for; the consensus is a starting point.

### Edge vs EV

Both are shown, and they are not the same:

| | means |
|---|---|
| **Edge %** | how many percentage points of probability you think the price is wrong by |
| **EV %** | what that error is worth per unit staked |

Two points of edge on a `+200` underdog is worth about three times what two
points is worth on a `-300` favourite. Sort by edge to find mispricings; look at
EV to decide what to bet.

### The flags

| Flag | Fires when |
|---|---|
| **MOVED** | a book's number has shifted ≥ 0.5 pts since this tool first saw it |
| **SHARP MOVE** | that move went *toward the underdog* — the shape sharp money leaves |
| **SHARP/PUBLIC** | Pinnacle and a public book disagree by > 0.5 pts (or > 15 cents on a moneyline) |
| **INFLATED FAV** | a favourite priced at or below the threshold with implied probability at or above the floor |

Alerts for all of these — plus **value opened** and **value closed** — stream
into the left panel over Server-Sent Events, so a line moving shows up without
waiting for the next poll.

### The parlay slip

Click `+` on any price. The slip gives you the combined odds, payout, profit,
break-even win rate, **required accuracy per leg**, your estimated win rate, EV,
and a suggested stake.

Two things it deliberately tells you that most parlay calculators do not:

- **Required accuracy per leg is the same as for a straight bet.** Three `-110`
  legs need 52.38% per leg — exactly what one `-110` bet needs. Parlaying does
  not raise the bar; it raises the variance.
- **Legs from the same game are correlated**, which breaks the independence
  assumption the payout maths rests on. The slip warns you, because the number
  it shows will overstate a correlated parlay (and most books void these unless
  offered as an explicit same-game parlay).

**Copy parlay slip** puts the whole ticket on your clipboard as plain text —
legs, prices, books, payout, break-even rate, EV and suggested stake — to take
to whichever book you actually bet at. The tool places no bets: no sportsbook
exposes a public bet-placement API, and a button that pretended to would be
lying to you. If the clipboard is unavailable the slip appears in a text box
instead.

### Stake sizing

Quarter-Kelly, hard-capped at 5% of bankroll (soft warning at 2%):

```
full Kelly   f* = (p·(dec−1) − (1−p)) / (dec−1)
suggested    min(f* × 0.25, 5% of bankroll)
```

Full Kelly is far too aggressive for parlays — the probability estimates are
noisy and the legs are never as independent as the maths pretends. The cap is
the point, not a limitation. No edge means a suggested stake of zero, and the
panel says so.

---

## Honest limitations

Read these before trusting a number.

**"Opening" means the first time this tool saw the line.** The Odds API's
historical endpoint is a paid add-on, so line movement is measured against this
tool's own first snapshot, persisted to `data/history.json`. Start the scanner
on Saturday morning and Saturday morning's number is your "open". The UI says
"first seen" for exactly this reason.

**Reverse line movement is approximated.** True RLM means the line moved against
where the public money went — and no free feed carries public ticket
percentages. What is flagged is the observable half: the number moving toward
the underdog. Treat it as a prompt to look, not as proof.

**Cross-number comparisons are approximate.** When the only reference price sits
on a different number than the offer (Pinnacle `-3`, DraftKings `-3.5`), the two
are converted with a half-point rule of thumb that charges key numbers (3, 7)
more than ordinary ones. Anything that leaned on it is marked `approx` in the UI
and `approx fair` in the CLI. Beyond about two points the conversion refuses to
guess and returns nothing rather than inventing an edge.

**Most prices grade negative, and that is correct.** Against a sharp de-vigged
line, most public prices genuinely are −EV. A board full of red is the market
working normally, not a bug. Real edges are rare, small, and disappear quickly —
which is what the "value closed" alert is for.

**Edges are estimates.** The consensus can be wrong, your override can be wrong,
and a 2% edge is well inside the noise of any of this. Nothing here is advice
and no bets are placed.

---

## API quota — read this before leaving it running

The free tier is ~500 credits/month. **One request costs `markets × regions`
credits** — 3 with the default `spreads,totals,h2h` over `us` — per sport.

The app therefore runs two independent clocks:

- **`UI_REFRESH_MS` (default 60s)** — how often the browser re-reads the
  server's cached board. Costs nothing. This is the 60-second live scan.
- **`FETCH_INTERVAL_MS` (default 5 min)** — how often the server may call The
  Odds API. This is what spends credits.

At the defaults, scanning both sports costs about 864 credits/day, so on a free
plan run it while you are using it rather than leaving it up overnight. A
literal 60-second upstream poll would spend a whole free month in about two
hours.

Three guards make overspending hard:

- `QUOTA_FLOOR` (default 20) — stop calling when the remaining balance gets
  this low, using the `x-requests-remaining` header the API returns,
- `DAILY_CALL_CAP` (default 200) — a hard per-process-day ceiling,
- the manual **Refresh** button forces a fetch but is still subject to both.

Remaining credits and calls-used-today are shown in the top bar.

---

## Terminal scanner

```bash
npm run scan -- --sport all --min-edge 1.5 --top 10
npm run scan -- --demo --market spreads --watch 120
npm run scan -- --json | jq '.games[0]'
```

```
  EDGE    EV      SELECTION                 LINE        BOOK        FAIR    NOTES
  +2.2%   +4.3%   Dallas Cowboys            +7 -105     Pinnacle    49.7%   sharp move / Pinnacle/DraftKings 1.0pt
          Dallas Cowboys @ Philadelphia Eagles
```

---

## HTTP API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/state` | the filtered, sorted board |
| `GET` | `/api/config` | books, markets, thresholds, risk policy |
| `GET` | `/api/quota` | upstream credit usage |
| `GET` | `/api/alerts` | recent alerts |
| `GET` | `/api/history/:lineKey` | sample series for one line |
| `GET` | `/api/events` | SSE stream of updates and alerts |
| `POST` | `/api/refresh` | force an upstream refresh (quota-guarded) |
| `POST` | `/api/estimate` | set/clear your probability for a selection |
| `POST` | `/api/parlay/quote` | parlay maths for a set of legs |

`/api/state` accepts `sport`, `markets`, `books`, `minEdge`, `highValueOnly`,
`liveOnly`, `sort` (`edge｜movement｜divergence｜time`) and `q`.

```bash
curl 'localhost:3000/api/state?sport=ncaaf&markets=spreads&minEdge=2&sort=edge'
```

---

## Layout

```
shared/          pure maths, imported by BOTH the server and the browser
  odds.js          implied probability, de-vig, edge, EV
  parlay.js        parlay odds, required accuracy, Kelly, stake sizing
src/
  server.js        node:http — JSON API + static UI + SSE
  scanner.js       orchestrates fetch → history → analysis → alerts
  cli.js           terminal scanner
  config.js        .env loading and every tunable threshold
  lib/
    oddsApi.js     The Odds API client, quota tracking and guards
    demoFeed.js    simulated feed in the exact API shape
    normalize.js   API shape → flat offers
    value.js       fair prices, grading, flags
    lineAdjust.js  half-point ↔ probability approximation
    history.js     line history, persisted to disk
    alerts.js      diff two scans into alerts
public/          the UI (vanilla ES modules, no build step)
test/            72 tests (node:test)
```

Parlay maths lives in `shared/` and is loaded by the browser *and* imported by
the server, so the slip in the UI and the `/api/parlay/quote` endpoint can never
disagree.

---

## Disclaimer

A research tool. It places no bets, and it is not betting advice. Edges are
estimates derived from public prices and can be wrong. Gamble responsibly, and
only with money you can afford to lose.
