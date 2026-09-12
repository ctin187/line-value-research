/**
 * Line history: the memory that makes movement detection possible.
 *
 * The Odds API's free tier serves only current odds -- the historical endpoint
 * is a paid add-on -- so "opening" here means the first time this process saw a
 * line. History is written to disk so that meaning survives a restart, and every
 * opening carries the timestamp it was captured at so the UI can say "since
 * 09:12" instead of implying it is the book's true open.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class LineHistory {
  constructor({ file = config.historyFile, depth = config.historyDepth } = {}) {
    this.file = file;
    this.depth = depth;
    /** key -> { opening, latest, samples: [{ ts, point, price }] } */
    this.entries = new Map();
    this.dirty = false;
    this.load();
  }

  get(key) {
    return this.entries.get(key);
  }

  size() {
    return this.entries.size;
  }

  /**
   * Record a batch of offers. Returns the list of lines whose number or price
   * changed since the previous sample, which is what drives alerts.
   */
  record(offers, ts = new Date().toISOString()) {
    const changes = [];

    for (const offer of offers) {
      const sample = { ts, point: offer.point ?? null, price: offer.price };
      let entry = this.entries.get(offer.key);

      if (!entry) {
        entry = {
          key: offer.key,
          gameId: offer.gameId,
          market: offer.market,
          selection: offer.selection,
          book: offer.book,
          opening: sample,
          latest: sample,
          samples: [sample],
        };
        this.entries.set(offer.key, entry);
        this.dirty = true;
        continue;
      }

      const prev = entry.latest;
      const pointChanged =
        typeof sample.point === 'number' &&
        typeof prev.point === 'number' &&
        Math.abs(sample.point - prev.point) > 0.001;
      const priceChanged = sample.price !== prev.price;

      if (pointChanged || priceChanged) {
        changes.push({
          key: offer.key,
          offer,
          previous: prev,
          current: sample,
          opening: entry.opening,
          pointDelta: pointChanged ? sample.point - prev.point : 0,
          priceDelta: priceChanged ? sample.price - prev.price : 0,
        });
        entry.samples.push(sample);
        if (entry.samples.length > this.depth) entry.samples.shift();
        entry.latest = sample;
        this.dirty = true;
      } else {
        // Unchanged lines still refresh the timestamp so staleness is visible.
        entry.latest = { ...prev, ts };
      }
    }

    return changes;
  }

  /** Full sample series for a line, oldest first. */
  series(key) {
    return this.entries.get(key)?.samples || [];
  }

  /** Drop lines for games that have left the feed, so the file cannot grow forever. */
  prune(liveGameIds) {
    const live = new Set(liveGameIds);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (!live.has(entry.gameId)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed) this.dirty = true;
    return removed;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const entry of raw.entries || []) {
        if (entry?.key) this.entries.set(entry.key, entry);
      }
    } catch (err) {
      // A corrupt history file must never stop the scanner from starting; the
      // worst case is that today's first sample becomes the new "opening".
      console.warn(`[history] could not read ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.dirty) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ savedAt: new Date().toISOString(), entries: [...this.entries.values()] }),
      );
      this.dirty = false;
      return true;
    } catch (err) {
      console.warn(`[history] could not write ${this.file}: ${err.message}`);
      return false;
    }
  }
}
