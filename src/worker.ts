/**
 * src/worker.ts — Cloudflare Worker entry point for Peggy's Card House.
 *
 * Serves two multiplayer card games from a single Worker:
 *   • Poker   → Table Durable Object        (legacy server.accept() API)
 *   • Blackjack → BlackjackRoom Durable Object (WebSocket Hibernation API)
 *
 * Static assets (Vite build → ./dist) are served automatically by the runtime
 * for every path EXCEPT those listed in `run_worker_first` (["/ws","/api/*"]).
 *
 * No node:crypto, no express, no ws — only Web-standard APIs:
 *   crypto.randomUUID(), crypto.getRandomValues(), WebSocketPair, etc.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  ServerMessage,
  GameState,
  PublicGameState,
  Player,
  Card,
  Suit,
  Rank,
  GamePhase,
  PublicCard,
} from "./shared/types";

// Re-export the poker Table DO and Scoreboard DO so Wrangler finds them.
export { Table } from "./poker/table";
export { Scoreboard } from "./scoreboard";

// ─── Environment bindings ───────────────────────────────────────
export interface Env {
  ASSETS: Fetcher;
  TABLES: DurableObjectNamespace;
  BLACKJACK_ROOMS: DurableObjectNamespace;
  SCOREBOARD: DurableObjectNamespace;
}

// ═════════════════════════════════════════════════════════════════
//  BLACKJACK ENGINE  (pure functions, no side-effects)
// ═════════════════════════════════════════════════════════════════

const SUITS: Suit[] = ["hearts", "diamonds", "clubs", "spades"];
const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const STARTING_CHIPS = 1000;
const MAX_PLAYERS = 6;
const BETTING_WINDOW_MS = 15_000;

function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
  return deck;
}

/** Fisher–Yates shuffle using cryptographically secure randomness. */
function shuffleDeck(deck: Card[]): Card[] {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const rand = crypto.getRandomValues(new Uint32Array(1))[0];
    const j = rand % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardValue(rank: Rank): number {
  if (rank === "A") return 11;
  if (rank === "K" || rank === "Q" || rank === "J" || rank === "10") return 10;
  return parseInt(rank, 10);
}

/** Returns { total, soft } — soft=true when an ace is still counted as 11. */
function handValue(hand: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === "A") { aces++; total += 11; }
    else total += cardValue(card.rank);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) { total -= 10; aces--; if (aces === 0) soft = false; }
  return { total, soft };
}

function isBlackjack(hand: Card[]): boolean {
  return hand.length === 2 && handValue(hand).total === 21;
}

function isBust(hand: Card[]): boolean {
  return handValue(hand).total > 21;
}

// ═════════════════════════════════════════════════════════════════
//  WORKER ENTRY  (fetch handler)
// ═════════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── WebSocket upgrade ──
    if (url.pathname === "/ws") {
      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const game = url.searchParams.get("game") || "poker";
      if (game === "blackjack") {
        const room = url.searchParams.get("room") || "main";
        const id = env.BLACKJACK_ROOMS.idFromName(room);
        return env.BLACKJACK_ROOMS.get(id).fetch(request);
      }
      // Default: poker
      const id = env.TABLES.idFromName("main");
      return env.TABLES.get(id).fetch(request);
    }

    // ── API routes ──
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, games: ["poker", "blackjack"], time: new Date().toISOString() });
    }
    if (url.pathname === "/api/scores" || url.pathname.startsWith("/api/scores/")) {
      const id = env.SCOREBOARD.idFromName("main");
      return env.SCOREBOARD.get(id).fetch(request);
    }

    // ── Everything else → static assets (SPA) ──
    return env.ASSETS.fetch(request);
  },
};

// ═════════════════════════════════════════════════════════════════
//  BlackjackRoom  —  Durable Object with WebSocket Hibernation API
// ═════════════════════════════════════════════════════════════════

interface WSAttachment {
  playerId: string;
}

export class BlackjackRoom extends DurableObject {
  state: GameState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = this.defaultState();
    // Restore persisted state before any message arrives
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)"
      );
      const rows = this.ctx.storage.sql.exec(
        "SELECT value FROM state WHERE key = 'game'"
      ).toArray();
      if (rows.length > 0) {
        try { this.state = JSON.parse(rows[0].value as string); } catch { /* keep defaults */ }
      }
    });
  }

  // ── Default state ─────────────────────────────────────────────
  defaultState(): GameState {
    return {
      phase: "waiting",
      dealerHand: [],
      players: [],
      currentPlayerId: null,
      message: "Waiting for players to join and bet.",
      round: 0,
      deck: [],
      bettingDeadline: null,
    };
  }

  // ── Persistence ───────────────────────────────────────────────
  persist(): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO state (key, value) VALUES ('game', ?)",
      JSON.stringify(this.state)
    );
  }

  // ── WebSocket upgrade (Hibernation API) ──────────────────────
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const playerId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId } as WSAttachment);

    // Greet the new connection
    this.send(server, { type: "joined", playerId, name: "Guest", chips: STARTING_CHIPS });
    this.send(server, { type: "state", state: this.toPublicState() });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation handlers ──────────────────────────────────────
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    let msg: ClientMessage;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch { return; }

    const att = ws.deserializeAttachment() as WSAttachment | null;
    const playerId = att?.playerId;
    if (!playerId) return;

    switch (msg.type) {
      case "join":   this.handleJoin(playerId, msg.name); break;
      case "bet":    this.handleBet(playerId, msg.amount); break;
      case "hit":    this.handleHit(playerId); break;
      case "stand":  this.handleStand(playerId); break;
      case "double": this.handleDouble(playerId); break;
      case "ready":  this.handleReady(playerId); break;
      case "leave":  this.handleLeave(playerId); break;
    }

    this.persist();
    this.broadcast();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as WSAttachment | null;
    if (att?.playerId) {
      this.handleLeave(att.playerId);
      this.persist();
      this.broadcast();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as WSAttachment | null;
    if (att?.playerId) {
      this.handleLeave(att.playerId);
      this.persist();
      this.broadcast();
    }
  }

  async alarm(): Promise<void> {
    // Betting window expired — start the round with whoever has bet
    if (this.state.phase === "betting") {
      const bettors = this.state.players.filter(p => p.status === "betting");
      if (bettors.length > 0) {
        this.startRound();
      } else {
        this.state.phase = "waiting";
        this.state.message = "No bets placed. Waiting for players.";
      }
      this.state.bettingDeadline = null;
      this.persist();
      this.broadcast();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  Game handlers
  // ═══════════════════════════════════════════════════════════════

  handleJoin(playerId: string, name: string): void {
    const cleanName = String(name || "Guest").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 16) || "Guest";
    let player = this.state.players.find(p => p.id === playerId);
    if (player) {
      player.name = cleanName;
    } else {
      const isFull = this.state.players.filter(p => p.status !== "spectating").length >= MAX_PLAYERS;
      player = {
        id: playerId,
        name: cleanName,
        chips: STARTING_CHIPS,
        hand: [],
        bet: 0,
        status: isFull ? "spectating" : "waiting",
        doubled: false,
      };
      this.state.players.push(player);
    }
    this.state.message = `${cleanName} joined the table.`;
  }

  handleBet(playerId: string, amount: number): void {
    // Allow betting from round_over (starts a new round)
    if (this.state.phase === "round_over") {
      this.resetForNewRound();
    }
    if (this.state.phase !== "waiting" && this.state.phase !== "betting") return;

    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.status === "spectating") return;
    if (player.chips <= 0) return;

    const bet = Math.max(1, Math.min(Math.floor(amount) || 0, player.chips));
    player.bet = bet;
    player.chips -= bet;
    player.status = "betting";
    player.hand = [];
    player.doubled = false;

    if (this.state.phase === "waiting") {
      this.state.phase = "betting";
      this.state.message = `${player.name} bet ${bet}. Place your bets!`;
      this.state.bettingDeadline = Date.now() + BETTING_WINDOW_MS;
      this.ctx.storage.setAlarm(this.state.bettingDeadline);
    }

    // If every active player has bet, start immediately
    const active = this.state.players.filter(p => p.status !== "spectating");
    if (active.length > 0 && active.every(p => p.status === "betting")) {
      this.ctx.storage.deleteAlarm();
      this.state.bettingDeadline = null;
      this.startRound();
    }
  }

  handleHit(playerId: string): void {
    if (this.state.phase !== "playing" || this.state.currentPlayerId !== playerId) return;
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.status !== "playing") return;

    player.hand.push(this.drawCard());
    const val = handValue(player.hand);

    if (val.total > 21) {
      player.status = "busted";
      this.state.message = `${player.name} busted at ${val.total}.`;
      this.advanceTurn();
    } else if (val.total === 21) {
      player.status = "stood";
      this.state.message = `${player.name} has 21 and stands.`;
      this.advanceTurn();
    }
  }

  handleStand(playerId: string): void {
    if (this.state.phase !== "playing" || this.state.currentPlayerId !== playerId) return;
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.status !== "playing") return;

    player.status = "stood";
    this.state.message = `${player.name} stands at ${handValue(player.hand).total}.`;
    this.advanceTurn();
  }

  handleDouble(playerId: string): void {
    if (this.state.phase !== "playing" || this.state.currentPlayerId !== playerId) return;
    const player = this.state.players.find(p => p.id === playerId);
    if (!player || player.status !== "playing" || player.hand.length !== 2) return;
    if (player.chips < player.bet) return;

    player.chips -= player.bet;
    player.bet *= 2;
    player.doubled = true;
    player.hand.push(this.drawCard());
    const val = handValue(player.hand);

    if (val.total > 21) {
      player.status = "busted";
      this.state.message = `${player.name} doubled and busted at ${val.total}.`;
    } else {
      player.status = "stood";
      this.state.message = `${player.name} doubled to ${val.total}.`;
    }
    this.advanceTurn();
  }

  handleReady(playerId: string): void {
    if (this.state.phase !== "round_over") return;
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;
    player.status = "waiting";
    player.hand = [];
    player.bet = 0;
    player.doubled = false;

    const active = this.state.players.filter(p => p.status !== "spectating");
    if (active.every(p => p.status === "waiting")) {
      this.resetForNewRound();
    }
  }

  handleLeave(playerId: string): void {
    const idx = this.state.players.findIndex(p => p.id === playerId);
    if (idx < 0) return;
    const player = this.state.players[idx];

    // Refund bet if still in betting phase
    if (player.status === "betting") player.chips += player.bet;

    this.state.players.splice(idx, 1);

    if (this.state.currentPlayerId === playerId) this.advanceTurn();
    this.state.message = `${player.name} left the table.`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Game flow
  // ═══════════════════════════════════════════════════════════════

  drawCard(): Card {
    if (this.state.deck.length < 10) this.state.deck = shuffleDeck(createDeck());
    return this.state.deck.pop()!;
  }

  resetForNewRound(): void {
    this.state.phase = "waiting";
    this.state.dealerHand = [];
    this.state.currentPlayerId = null;
    this.state.message = "Ready for next round. Place your bets!";
    for (const p of this.state.players) {
      if (p.status !== "spectating") {
        p.status = "waiting";
        p.hand = [];
        p.bet = 0;
        p.doubled = false;
      }
    }
  }

  startRound(): void {
    this.state.phase = "playing";
    this.state.round++;
    this.state.deck = shuffleDeck(createDeck());
    this.state.dealerHand = [this.drawCard(), this.drawCard()];
    this.state.bettingDeadline = null;

    // Deal 2 cards to each player who bet
    for (const player of this.state.players) {
      if (player.status === "betting") {
        player.hand = [this.drawCard(), this.drawCard()];
        player.status = isBlackjack(player.hand) ? "blackjack" : "playing";
      }
    }

    // Dealer blackjack → reveal and resolve immediately
    if (isBlackjack(this.state.dealerHand)) {
      this.state.phase = "dealer_turn";
      this.state.message = "Dealer has Blackjack!";
      this.resolveRound();
      return;
    }

    // If nobody needs to act (all blackjack), go straight to dealer
    const playing = this.state.players.filter(p => p.status === "playing");
    if (playing.length === 0) {
      this.state.phase = "dealer_turn";
      this.dealerPlay();
      return;
    }

    this.state.currentPlayerId = playing[0].id;
    this.state.message = `Dealing complete. ${playing[0].name}'s turn.`;
  }

  advanceTurn(): void {
    const playing = this.state.players.filter(p => p.status === "playing");
    if (playing.length === 0) {
      this.state.currentPlayerId = null;
      this.state.phase = "dealer_turn";
      this.dealerPlay();
      return;
    }

    // Find next playing player after the current one
    const curIdx = this.state.players.findIndex(p => p.id === this.state.currentPlayerId);
    for (let i = 1; i <= this.state.players.length; i++) {
      const idx = (curIdx + i) % this.state.players.length;
      if (this.state.players[idx].status === "playing") {
        this.state.currentPlayerId = this.state.players[idx].id;
        this.state.message = `${this.state.players[idx].name}'s turn.`;
        return;
      }
    }

    // Fallback — shouldn't reach here
    this.state.currentPlayerId = null;
    this.state.phase = "dealer_turn";
    this.dealerPlay();
  }

  dealerPlay(): void {
    // Dealer stands on all 17s (hard and soft)
    while (handValue(this.state.dealerHand).total < 17) {
      this.state.dealerHand.push(this.drawCard());
    }
    this.resolveRound();
  }

  resolveRound(): void {
    this.state.phase = "round_over";
    const dealerTotal = handValue(this.state.dealerHand).total;
    const dealerBust = isBust(this.state.dealerHand);
    const dealerBJ = isBlackjack(this.state.dealerHand);
    const parts: string[] = [];

    for (const player of this.state.players) {
      if (player.status === "spectating" || player.status === "waiting") continue;

      // Already busted during play
      if (player.status === "busted") {
        player.status = "lost";
        parts.push(`${player.name} lost ${player.bet}`);
        continue;
      }

      const playerBJ = player.status === "blackjack";

      if (playerBJ && dealerBJ) {
        player.status = "push";
        player.chips += player.bet; // return bet
        parts.push(`${player.name} pushed`);
      } else if (playerBJ) {
        player.status = "won";
        player.chips += Math.floor(player.bet * 2.5); // 3:2 payout
        parts.push(`${player.name} won ${Math.floor(player.bet * 1.5)} ♠`);
      } else if (dealerBust) {
        player.status = "won";
        player.chips += player.bet * 2; // 1:1
        parts.push(`${player.name} won ${player.bet}`);
      } else if (handValue(player.hand).total > dealerTotal) {
        player.status = "won";
        player.chips += player.bet * 2;
        parts.push(`${player.name} won ${player.bet}`);
      } else if (handValue(player.hand).total < dealerTotal) {
        player.status = "lost";
        parts.push(`${player.name} lost ${player.bet}`);
      } else {
        player.status = "push";
        player.chips += player.bet;
        parts.push(`${player.name} pushed`);
      }
    }

    this.state.message = parts.join(" · ") || "Round over.";
    this.state.currentPlayerId = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Public state & broadcast
  // ═══════════════════════════════════════════════════════════════

  /**
   * Convert internal state to what clients may see.
   * The dealer's hole card (index 1) is replaced with null until
   * the phase reaches dealer_turn or round_over.
   */
  toPublicState(): PublicGameState {
    const reveal = this.state.phase === "dealer_turn" || this.state.phase === "round_over";
    const dealerHand: PublicCard[] = this.state.dealerHand.map((card, i) =>
      !reveal && i === 1 ? null : card
    );

    return {
      phase: this.state.phase,
      dealerHand,
      players: this.state.players.map(p => ({ ...p, hand: [...p.hand] })),
      currentPlayerId: this.state.currentPlayerId,
      message: this.state.message,
      round: this.state.round,
    };
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* connection may be closing */ }
  }

  broadcast(): void {
    const pub = this.toPublicState();
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { type: "state", state: pub });
    }
  }
}
