#!/usr/bin/env node
/**
 * Terminal scan: one shot, no server, no browser.
 *
 *   npm run scan -- --sport ncaaf --min-edge 1.5 --market spreads
 *   npm run scan -- --demo --watch 60
 *
 * Useful for a quick look before opening the UI, and for piping into anything
 * else. `--watch` re-scans on an interval and respects the same quota guards as
 * the server, so it will not quietly drain a free-tier plan.
 */
import { config, SPORTS, MARKETS } from './config.js';
import { Scanner } from './scanner.js';
import { formatAmerican, formatPoint } from '../shared/odds.js';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
Line Value Research -- terminal scan

  --sport <nfl|ncaaf|all>   sport to scan            (default: nfl)
  --market <key[,key]>      ${Object.keys(MARKETS).join(', ')}   (default: all)
  --min-edge <pct>          only show selections at or above this edge
  --top <n>                 rows to print per sport  (default: 15)
  --watch <seconds>         re-scan on an interval
  --demo                    use the simulated feed instead of the live API
  --json                    emit JSON instead of a table
  --help
`);
  process.exit(0);
}

const scanner = new Scanner();
if (args.demo) scanner.demo = true;

const sports = args.sport === 'all' ? Object.keys(SPORTS) : [args.sport];
for (const sport of sports) {
  if (!SPORTS[sport]) {
    console.error(`Unknown sport '${sport}'. Choose from: ${Object.keys(SPORTS).join(', ')}, all`);
    process.exit(1);
  }
}

async function scanOnce() {
  for (const sport of sports) {
    await scanner.refresh(sport, { force: true });
    const view = scanner.view({
      sport,
      markets: args.market,
      minEdgePct: args.minEdge,
      sort: 'edge',
    });

    if (args.json) {
      console.log(JSON.stringify(view, null, 2));
      continue;
    }
    printSport(view);
  }
}

function printSport(view) {
  const header = `${SPORTS[view.sport].label}  |  ${view.gameCount}/${view.totalGames} games  |  ${view.mode} feed`;
  console.log(`\n${bold(header)}`);
  if (view.error) console.log(red(`  ! ${view.error.message}`));
  if (view.mode === 'demo') console.log(yellow('  simulated lines -- set ODDS_API_KEY for live odds'));
  console.log(dim('  ' + '-'.repeat(header.length)));

  const rows = view.games
    .flatMap((game) => game.selections.map((sel) => ({ game, sel })))
    .filter((row) => row.sel.best && row.sel.bestEdgePct !== null)
    .sort((a, b) => b.sel.bestEdgePct - a.sel.bestEdgePct)
    .slice(0, args.top);

  if (!rows.length) {
    console.log(dim('  nothing matches those filters right now.'));
    return;
  }

  console.log(
    dim(
      '  ' + pad('EDGE', 8) + pad('EV', 8) + pad('SELECTION', 26) + pad('LINE', 12)
      + pad('BOOK', 12) + pad('FAIR', 8) + 'NOTES',
    ),
  );

  for (const { game, sel } of rows) {
    const best = sel.best;
    const line = sel.market === 'h2h' || best.point === null
      ? formatAmerican(best.price)
      : `${formatPoint(best.point, { signed: sel.market !== 'totals' })} ${formatAmerican(best.price)}`;

    const notes = [];
    if (sel.flags.includes('REVERSE_LINE_MOVE')) notes.push('sharp move');
    else if (sel.flags.includes('LINE_MOVE')) notes.push(`moved ${Math.abs(sel.maxMovePoints).toFixed(1)}`);
    if (sel.divergence?.triggered) {
      const gap = sel.divergence.unit === 'points'
        ? `${sel.divergence.magnitude.toFixed(1)}pt`
        : `${Math.round(sel.divergence.magnitude)}c`;
      notes.push(`${sel.divergence.sharpBookTitle}/${sel.divergence.bookTitle} ${gap}`);
    }
    if (sel.flags.includes('INFLATED_FAVORITE')) notes.push('inflated fav');
    if (sel.fairApprox) notes.push('approx fair');

    const edgeText = `${sel.bestEdgePct >= 0 ? '+' : ''}${sel.bestEdgePct.toFixed(1)}%`;
    const colour = sel.bestEdgePct >= config.thresholds.highEdgePct ? green
      : sel.bestEdgePct >= config.thresholds.moderateEdgePct ? yellow
        : sel.bestEdgePct < 0 ? red : dim;

    console.log(
      '  ' + colour(pad(edgeText, 8))
      + pad(`${sel.bestEvPct >= 0 ? '+' : ''}${sel.bestEvPct.toFixed(1)}%`, 8)
      + pad(truncate(sel.selection, 24), 26)
      + pad(line, 12)
      + pad(best.bookTitle, 12)
      + pad(`${(sel.fairProb * 100).toFixed(1)}%`, 8)
      + dim(notes.join(' / ')),
    );
    console.log(dim('  ' + ' '.repeat(8) + truncate(game.matchup, 60)));
  }

  const quota = scanner.client.snapshot();
  if (quota.configured && quota.remaining !== null) {
    console.log(dim(`\n  ${quota.remaining} API credits remaining / ${quota.callsToday} of ${quota.dailyCallCap} calls today`));
  }
}

/* ------------------------------------------------------------ helpers */

function parseArgs(argv) {
  const out = {
    sport: 'nfl', market: null, minEdge: null, top: 15,
    watch: null, demo: false, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[i + 1];
    switch (argv[i]) {
      case '--sport': out.sport = next(); i += 1; break;
      case '--market': out.market = next()?.split(',').map((s) => s.trim()).filter(Boolean); i += 1; break;
      case '--min-edge': out.minEdge = Number(next()); i += 1; break;
      case '--top': out.top = Number(next()) || 15; i += 1; break;
      case '--watch': out.watch = Number(next()) || 60; i += 1; break;
      case '--demo': out.demo = true; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': out.help = true; break;
      default: break;
    }
  }
  if (!Number.isFinite(out.minEdge)) out.minEdge = null;
  return out;
}

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = String.fromCharCode(27);
const wrap = (code) => (s) => (useColour ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = wrap('1');
const dim = wrap('2');
const red = wrap('31');
const green = wrap('32');
const yellow = wrap('33');

function pad(value, width) {
  const str = String(value ?? '');
  return str.length >= width ? `${str} ` : str + ' '.repeat(width - str.length);
}

function truncate(value, max) {
  const str = String(value ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}...`;
}

/* --------------------------------------------------------------- run */
// Kept last so the colour helpers above are initialised before the first print
// (top-level await would otherwise run while those consts are still in the TDZ).
await scanOnce();

if (args.watch) {
  const ms = Math.max(15, args.watch) * 1000;
  console.log(dim(`\nwatching -- re-scanning every ${ms / 1000}s (ctrl-c to stop)\n`));
  setInterval(scanOnce, ms);
}
