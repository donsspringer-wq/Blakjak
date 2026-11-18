/**
 * src/poker/table.ts — Peggy's Poker Table Durable Object.
 *
 * Ported from the original peggys-poker/worker.js with two changes:
 *   1. Inline HTML removed (now served by Vite static assets).
 *   2. Math.random() → crypto.getRandomValues() for secure shuffling.
 *
 * Uses the legacy server.accept() WebSocket API (the DO stays alive while
 * connections are open, so setTimeout timers work normally).
 */

import { DurableObject } from "cloudflare:workers";

// ─── Constants ──────────────────────────────────────────────────
const MAX_SEATS = 6;
const START_CHIPS = 1000;
const ANTE = 20;
const MIN_RAISE = 10;
const MAX_DISCARD = 4;
const HAND_NAMES = ["High Card", "Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", "Straight Flush"];
const BANNED = ["badword1", "badword2"];
const FILTER = new RegExp("\\b(" + BANNED.join("|") + ")\\b", "gi");

// ─── Utilities ───────────────────────────────────────────────────
function clean(s: unknown, max: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}
function filterText(s: string): string {
  return s.replace(FILTER, (m) => "*".repeat(m.length));
}

function newDeck(): any[] {
  const d: any[] = [];
  for (const s of ["S", "H", "D", "C"]) for (let r = 2; r <= 14; r++) d.push({ r, s });
  return d;
}

/** Fisher–Yates shuffle using cryptographically secure randomness. */
function shuffle(a: any[]): any[] {
  for (let i = a.length - 1; i > 0; i--) {
    const rand = crypto.getRandomValues(new Uint32Array(1))[0];
    const j = rand % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function evalFive(cs: any[]): number[] {
  const ranks = cs.map((c: any) => c.r).sort((a: number, b: number) => b - a);
  const flush = cs.every((c: any) => c.s === cs[0].s);
  const uniq = [...new Set(ranks)];
  let straight = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straight = uniq[0];
    else if (uniq.join(",") === "14,5,4,3,2") straight = 5;
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const g = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  if (flush && straight) return [8, straight];
  if (g[0][1] === 4) return [7, g[0][0], g[1][0]];
  if (g[0][1] === 3 && g[1][1] === 2) return [6, g[0][0], g[1][0]];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (g[0][1] === 3) return [3, g[0][0], g[1][0], g[2][0]];
  if (g[0][1] === 2 && g[1][1] === 2) return [2, g[0][0], g[1][0], g[2][0]];
  if (g[0][1] === 2) return [1, g[0][0], ...g.slice(1).map((x) => x[0])];
  return [0, ...ranks];
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function handName(s: number[]): string {
  if (s[0] === 8 && s[1] === 14) return "Royal Flush";
  return HAND_NAMES[s[0]];
}

function maxDiscardFor(hand: any[]): number {
  return hand.every((c) => c.r >= 2 && c.r <= 10) ? 5 : MAX_DISCARD;
}

function buildPots(players: any[]): any[] {
  const pots: any[] = [];
  let prev = 0;
  const levels = [...new Set(players.map((p: any) => p.contrib).filter((c: number) => c > 0))].sort((a: number, b: number) => a - b);
  for (const lvl of levels) {
    const payers = players.filter((p: any) => p.contrib >= lvl).length;
    const amount = (lvl - prev) * payers;
    const eligible = players.filter((p: any) => p.contrib >= lvl && !p.folded);
    if (eligible.length === 0 && pots.length) pots[pots.length - 1].amount += amount;
    else pots.push({ amount, eligible });
    prev = lvl;
  }
  return pots;
}

// ═════════════════════════════════════════════════════════════════
//  Table Durable Object
// ═════════════════════════════════════════════════════════════════

export class Table extends DurableObject {
  sockets: Map<WebSocket, any> = new Map();
  seats: any[] = Array(MAX_SEATS).fill(null);
  reserve: string[] = [];
  phase: string = "waiting";
  round: number = 1;
  dealer: number = -1;
  turn: number = -1;
  ante: number = ANTE;
  deck: any[] = [];
  discardPile: any[] = [];
  acted: Set<number> = new Set();
  msg: string = "Sit down to play. First come, first served; extra players can reserve a seat.";
  handNo: number = 0;
  results: any[] | null = null;
  timer: ReturnType<typeof setTimeout> | null = null;
  baseUrl: string | null = null;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
  }

  // ── WebSocket upgrade (legacy server.accept) ──────────────────
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    this.baseUrl = this.baseUrl || new URL(request.url).origin;
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const p = {
      id: crypto.randomUUID(),
      name: "Guest",
      ws: server,
      seat: -1,
      chips: START_CHIPS,
      hand: [] as any[],
      contrib: 0,
      bet: 0,
      folded: false,
      discarded: false,
      inHand: false,
      leave: false,
    };
    this.sockets.set(server, p);
    server.addEventListener("message", (e: MessageEvent) => this.onMessage(server, e.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws: WebSocket, raw: string): void {
    const p = this.sockets.get(ws);
    if (!p) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      switch (m.type) {
        case "name":  p.name = filterText(clean(m.name, 16)) || "Guest"; break;
        case "sit":   this.sit(p); break;
        case "stand": this.stand(p); break;
        case "ante":  this.setAnte(p, m.ante); break;
        case "check": this.check(p); break;
        case "call":  this.call(p); break;
        case "raise": this.raise(p, Number(m.amount)); break;
        case "fold":  this.fold(p); break;
        case "discard": this.discard(p, m.indexes); break;
      }
    } catch {
      this.send(ws, { type: "error", msg: "Something went wrong. Please try again." });
    }
    this.broadcast();
  }

  send(ws: WebSocket, obj: any): void {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  broadcast(): void {
    for (const [ws, p] of this.sockets) this.send(ws, this.viewFor(p));
  }

  viewFor(p: any): any {
    const mb = this.maxBet();
    return {
      type: "table",
      phase: this.phase,
      msg: this.msg,
      handNo: this.handNo,
      round: this.round,
      ante: this.ante,
      dealer: this.dealer,
      turn: this.turn,
      minRaise: MIN_RAISE,
      maxDiscard: p.seat >= 0 && p.hand.length ? maxDiscardFor(p.hand) : 0,
      pot: this.seats.reduce((t: number, q: any) => t + (q ? q.contrib : 0), 0),
      toCall: p.seat >= 0 ? Math.max(0, mb - p.bet) : 0,
      yourSeat: p.seat,
      reservedPosition: this.reserve.indexOf(p.id) + 1,
      reserve: this.reserve.length,
      seats: this.seats.map((q: any) =>
        q
          ? {
              name: q.name,
              chips: q.chips,
              inHand: q.inHand,
              folded: q.folded,
              discarded: q.discarded,
              bet: q.bet,
              contrib: q.contrib,
              count: q.hand.length,
              cards: (q === p || this.phase === "showdown") && q.inHand ? q.hand : null,
            }
          : null
      ),
      results: this.results,
    };
  }

  // ── Seats ─────────────────────────────────────────────────────
  sit(p: any): void {
    if (p.seat >= 0) return;
    const free = this.seats.indexOf(null);
    if (free >= 0) {
      this.takeSeat(p, free);
      if (this.phase === "waiting") this.startHand();
    } else if (!this.reserve.includes(p.id)) {
      this.reserve.push(p.id);
    }
  }

  takeSeat(p: any, i: number): void {
    this.seats[i] = p;
    p.seat = i;
    p.chips = START_CHIPS;
    p.inHand = false;
    p.leave = false;
    this.reserve = this.reserve.filter((id) => id !== p.id);
  }

  clearSeat(p: any): void {
    if (p.seat >= 0) this.seats[p.seat] = null;
    p.seat = -1;
    p.inHand = false;
    p.leave = false;
  }

  promote(): void {
    while (this.seats.includes(null) && this.reserve.length) {
      const id = this.reserve.shift()!;
      const q = [...this.sockets.values()].find((x) => x.id === id);
      if (q) this.takeSeat(q, this.seats.indexOf(null));
    }
  }

  stand(p: any): void {
    if (p.seat < 0) {
      this.reserve = this.reserve.filter((id) => id !== p.id);
      return;
    }
    if (p.inHand) {
      p.leave = true;
      return;
    }
    this.clearSeat(p);
    this.promote();
  }

  onClose(ws: WebSocket): void {
    const p = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (!p) return;
    this.reserve = this.reserve.filter((id) => id !== p.id);
    if (p.seat >= 0) {
      if (p.inHand) p.leave = true;
      else {
        this.clearSeat(p);
        this.promote();
      }
    }
    this.broadcast();
  }

  // ── Hand flow ─────────────────────────────────────────────────
  seatsInHand(): any[] {
    return this.seats.filter((q) => q && q.inHand);
  }
  maxBet(): number {
    return Math.max(0, ...this.seatsInHand().map((q) => q.bet));
  }
  toCall(p: any): number {
    return this.maxBet() - p.bet;
  }
  isTurn(p: any): boolean {
    return this.phase === "bet" && p && this.seats[this.turn] === p;
  }

  startHand(): void {
    this.clearTimer();
    const live: number[] = [];
    for (let i = 0; i < MAX_SEATS; i++) if (this.seats[i] && this.seats[i].chips > 0) live.push(i);
    if (live.length < 2) {
      this.phase = "waiting";
      this.dealer = -1;
      this.turn = -1;
      this.msg = "Waiting for at least 2 players. Sit down to start.";
      return;
    }
    let d = this.dealer;
    do {
      d = (d + 1) % MAX_SEATS;
    } while (!this.seats[d] || this.seats[d].chips <= 0);
    this.dealer = d;
    this.handNo++;
    this.round = 1;
    this.results = null;
    this.deck = [];
    this.discardPile = [];
    for (let i = 0; i < MAX_SEATS; i++) if (this.seats[i]) this.seats[i].inHand = live.includes(i);
    for (const i of live) {
      Object.assign(this.seats[i], { hand: [], contrib: 0, bet: 0, folded: false, discarded: false });
    }
    this.phase = "ante";
    this.turn = -1;
    this.msg = "Hand " + this.handNo + ": " + this.seats[d].name + " is dealing and sets the ante.";
    this.setTimer(20000, () => this.setAnte(null, ANTE, true));
  }

  setAnte(p: any, ante: number, force = false): void {
    if (this.phase !== "ante") return;
    if (!force && p !== this.seats[this.dealer]) return;
    const a = Math.floor(Number(ante));
    this.ante = Number.isFinite(a) && a >= 5 && a <= 1000 ? a : ANTE;
    this.deck = shuffle(newDeck());
    for (const q of this.seatsInHand()) {
      const x = Math.min(this.ante, q.chips);
      q.chips -= x;
      q.contrib = x;
      q.hand = this.draw(5);
    }
    this.msg = "Ante is " + this.ante + ". Betting round 1.";
    this.phase = "bet";
    this.beginRound();
  }

  draw(n: number): any[] {
    if (this.deck.length < n) {
      this.deck = shuffle(this.deck.concat(this.discardPile));
      this.discardPile = [];
    }
    return this.deck.splice(0, n);
  }

  beginRound(): void {
    for (const q of this.seatsInHand()) q.bet = 0;
    this.acted = new Set();
    this.turn = this.dealer;
    this.advance();
  }

  advance(): void {
    const left = this.seatsInHand().filter((q) => !q.folded);
    if (left.length <= 1) return this.showdown();
    const next = this.nextToAct();
    if (next < 0) return this.endRound();
    this.turn = next;
    this.msg = this.seats[next].name + "'s turn.";
    this.setTimer(30000, () => {
      const q = this.seats[this.turn];
      if (q) this.autoAct(q);
    });
  }

  nextToAct(): number {
    const mb = this.maxBet();
    const live = this.seatsInHand().filter((q) => !q.folded && q.chips > 0);
    if (live.length === 0) return -1;
    if (live.length === 1 && live[0].bet >= mb) return -1;
    for (let k = 1; k <= MAX_SEATS; k++) {
      const i = (this.turn + k) % MAX_SEATS;
      const q = this.seats[i];
      if (q && q.inHand && !q.folded && q.chips > 0 && (!this.acted.has(i) || q.bet < mb)) return i;
    }
    return -1;
  }

  endRound(): void {
    this.clearTimer();
    this.acted = new Set();
    this.turn = -1;
    if (this.round === 1) {
      this.phase = "discard";
      this.msg = "Discard up to " + MAX_DISCARD + " cards (5 if no face cards or aces), or keep your hand.";
      this.setTimer(30000, () => {
        for (const q of this.seatsInHand()) if (!q.folded) this.discard(q, []);
      });
    } else {
      this.showdown();
    }
  }

  pay(p: any, x: number): void {
    p.chips -= x;
    p.bet += x;
    p.contrib += x;
  }

  autoAct(q: any): void {
    if (this.toCall(q) === 0) this.check(q);
    else this.fold(q);
  }

  check(p: any): void {
    if (!this.isTurn(p) || this.toCall(p) !== 0) return;
    this.acted.add(this.turn);
    this.advance();
  }

  call(p: any): void {
    if (!this.isTurn(p)) return;
    const need = this.toCall(p);
    if (need <= 0) return this.check(p);
    this.pay(p, Math.min(need, p.chips));
    this.acted.add(this.turn);
    this.advance();
  }

  raise(p: any, by: number): void {
    if (!this.isTurn(p) || !Number.isFinite(by)) return;
    by = Math.floor(by);
    if (by <= 0) return;
    const need = this.toCall(p);
    const pay = Math.min(need + by, p.chips);
    if (pay <= need) return this.call(p);
    if (by < MIN_RAISE && pay < p.chips) return;
    this.pay(p, pay);
    this.acted = new Set([this.turn]);
    this.advance();
  }

  fold(p: any): void {
    if (!this.isTurn(p)) return;
    p.folded = true;
    this.acted.add(this.turn);
    this.advance();
  }

  discard(p: any, indexes: any): void {
    if (this.phase !== "discard" || !p || !p.inHand || p.folded || p.discarded) return;
    const limit = maxDiscardFor(p.hand);
    const idx = [...new Set((Array.isArray(indexes) ? indexes : []).map(Number))]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < p.hand.length)
      .slice(0, limit);
    const drop = new Set(idx);
    for (const i of idx) this.discardPile.push(p.hand[i]);
    p.hand = p.hand.filter((_: any, i: number) => !drop.has(i)).concat(this.draw(idx.length));
    p.discarded = true;
    if (this.seatsInHand().filter((q) => !q.folded).every((q) => q.discarded)) {
      this.round = 2;
      this.phase = "bet";
      this.msg = "Betting round 2.";
      this.beginRound();
    }
  }

  showdown(): void {
    this.clearTimer();
    this.phase = "showdown";
    this.turn = -1;
    const seated = this.seatsInHand();
    const score = new Map<any, number[]>();
    for (const q of seated) if (!q.folded) score.set(q, evalFive(q.hand));
    const won = new Map<any, number>();
    for (const pot of buildPots(seated)) {
      const el = pot.eligible.filter((q) => score.has(q));
      if (!el.length) continue;
      let best = score.get(el[0])!;
      for (const q of el) if (cmp(score.get(q)!, best) > 0) best = score.get(q)!;
      const ws = el.filter((q) => cmp(score.get(q)!, best) === 0);
      const share = Math.floor(pot.amount / ws.length);
      const rem = pot.amount - share * ws.length;
      ws.forEach((w) => {
        w.chips += share;
        won.set(w, (won.get(w) || 0) + share);
      });
      ws[0].chips += rem;
      won.set(ws[0], (won.get(ws[0]) || 0) + rem);
    }
    const total = [...won.values()].reduce((a, b) => a + b, 0);
    this.results = seated.map((q) => ({
      name: q.name,
      hand: q.folded ? "folded" : handName(score.get(q)!),
      won: won.has(q),
    }));
    const names = [...won.keys()].map((q) => q.name).join(" and ");
    this.msg = names ? names + " won " + total + " chips." : "Hand over.";
    this.submitScores(won);
    for (const q of seated) if (q.leave || q.chips <= 0) this.clearSeat(q);
    this.promote();
    this.setTimer(7000, () => this.startHand());
  }

  async submitScores(won: Map<any, number>): Promise<void> {
    if (!this.baseUrl) return;
    for (const [q, chips] of won) {
      if (chips < 1) continue;
      try {
        await fetch(this.baseUrl + "/api/scores/peggys-poker", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: q.name, score: chips }),
        });
      } catch {}
    }
  }

  // ── Timers ─────────────────────────────────────────────────────
  setTimer(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
      this.broadcast();
    }, ms);
  }
  clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
