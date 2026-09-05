/**
 * Alert generation. Turns the diff between two scans into the three notices the
 * scanner is specified to raise:
 *
 *   1. a line moved by the configured threshold (default 0.5 points),
 *   2. sharp/public disagreement opened up where there was none,
 *   3. a line that was previously flagged as value moved against you and closed.
 *
 * Alerts are de-duplicated by a signature so a line that keeps drifting inside
 * one refresh window does not spam the feed.
 */
import { config } from '../config.js';
import { formatPoint, formatAmerican } from '../../shared/odds.js';

export const ALERT_KINDS = {
  LINE_MOVE: 'line-move',
  DIVERGENCE: 'divergence',
  VALUE_CLOSED: 'value-closed',
  VALUE_OPENED: 'value-opened',
};

export class AlertLog {
  constructor({ depth = config.alertDepth } = {}) {
    this.items = [];
    this.depth = depth;
    this.seen = new Map();
    this.seq = 0;
  }

  /** Add an alert unless an identical one fired within `dedupeMs`. */
  push(alert, { dedupeMs = 10 * 60_000 } = {}) {
    const now = Date.now();
    const last = this.seen.get(alert.signature);
    if (last && now - last < dedupeMs) return null;

    this.seen.set(alert.signature, now);
    this.seq += 1;
    const withId = { id: this.seq, ts: new Date().toISOString(), ...alert };
    this.items.unshift(withId);
    if (this.items.length > this.depth) this.items.pop();
    return withId;
  }

  list(limit = 50) {
    return this.items.slice(0, limit);
  }

  clear() {
    this.items = [];
    this.seen.clear();
  }
}

/**
 * Build alerts for one scan.
 *
 * `changes` come from LineHistory.record(); `games` are the freshly analysed
 * games; `previousBySelection` is the previous scan's selection map, used to
 * notice value appearing and disappearing.
 */
export function buildAlerts({ changes, games, previousBySelection = new Map() }) {
  const alerts = [];
  const gameById = new Map(games.map((g) => [g.id, g]));
  const threshold = config.thresholds.lineMovePoints;

  for (const change of changes) {
    const game = gameById.get(change.offer.gameId);
    if (!game) continue;
    if (Math.abs(change.pointDelta) < threshold) continue;

    const dir = change.pointDelta > 0 ? '↑' : '↓';
    alerts.push({
      kind: ALERT_KINDS.LINE_MOVE,
      severity: Math.abs(change.pointDelta) >= threshold * 2 ? 'high' : 'normal',
      gameId: game.id,
      sport: game.sport,
      matchup: game.matchup,
      market: change.offer.market,
      selection: change.offer.selection,
      book: change.offer.bookTitle,
      signature: `move:${change.key}:${change.current.point}`,
      message:
        `${change.offer.selection} ${change.offer.market} moved ${dir} ` +
        `${Math.abs(change.pointDelta).toFixed(1)} pts at ${change.offer.bookTitle} ` +
        `(${formatPoint(change.previous.point)} → ${formatPoint(change.current.point)})`,
      detail: {
        from: change.previous.point,
        to: change.current.point,
        openedAt: change.opening?.ts,
        openingPoint: change.opening?.point,
      },
    });
  }

  for (const game of games) {
    for (const sel of game.selections) {
      const prev = previousBySelection.get(sel.selKey);

      if (sel.divergence?.triggered && !prev?.divergence?.triggered) {
        const d = sel.divergence;
        const gap = d.unit === 'points' ? `${d.magnitude.toFixed(1)} pts` : `${Math.round(d.magnitude)} cents`;
        alerts.push({
          kind: ALERT_KINDS.DIVERGENCE,
          severity: 'normal',
          gameId: game.id,
          sport: game.sport,
          matchup: game.matchup,
          market: sel.market,
          selection: sel.selection,
          signature: `diverge:${sel.selKey}:${gap}`,
          message:
            `${d.sharpBookTitle} differs from ${d.bookTitle} by ${gap} on ` +
            `${sel.selection} ${sel.market} — sharp/public disagreement`,
          detail: d,
        });
      }

      const wasValue = (prev?.bestEdgePct ?? -99) >= config.thresholds.highEdgePct;
      const isValue = (sel.bestEdgePct ?? -99) >= config.thresholds.highEdgePct;

      if (wasValue && !isValue) {
        alerts.push({
          kind: ALERT_KINDS.VALUE_CLOSED,
          severity: 'high',
          gameId: game.id,
          sport: game.sport,
          matchup: game.matchup,
          market: sel.market,
          selection: sel.selection,
          signature: `closed:${sel.selKey}:${Math.round((sel.bestEdgePct ?? 0) * 10)}`,
          message:
            `Value closed on ${sel.selection} ${sel.market} — edge fell from ` +
            `${prev.bestEdgePct.toFixed(1)}% to ${(sel.bestEdgePct ?? 0).toFixed(1)}%` +
            (sel.best ? ` (now ${formatAmerican(sel.best.price)} at ${sel.best.bookTitle})` : ''),
          detail: { previousEdgePct: prev.bestEdgePct, currentEdgePct: sel.bestEdgePct },
        });
      }

      if (!wasValue && isValue && prev) {
        alerts.push({
          kind: ALERT_KINDS.VALUE_OPENED,
          severity: 'normal',
          gameId: game.id,
          sport: game.sport,
          matchup: game.matchup,
          market: sel.market,
          selection: sel.selection,
          signature: `opened:${sel.selKey}:${Math.round((sel.bestEdgePct ?? 0) * 10)}`,
          message:
            `New value: ${sel.selection} ${sel.market} at ${sel.best.bookTitle} ` +
            `${formatAmerican(sel.best.price)} — edge ${sel.bestEdgePct.toFixed(1)}%`,
          detail: { currentEdgePct: sel.bestEdgePct, book: sel.best.book },
        });
      }
    }
  }

  return alerts;
}
