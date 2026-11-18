/**
 * Shared protocol types — imported by BOTH the Cloudflare Worker (src/worker.ts)
 * and the React frontend.  Keep this file free of runtime code so it tree-shakes
 * cleanly in both bundles.
 */

// ─── Cards ──────────────────────────────────────────────────────
export type Suit = "hearts" | "diamonds" | "clubs" | "spades";
export type Rank =
  | "A" | "2" | "3" | "4" | "5" | "6" | "7"
  | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  suit: Suit;
  rank: Rank;
}

// ─── Players ────────────────────────────────────────────────────
export type PlayerStatus =
  | "waiting"      // in the room, no bet yet
  | "betting"      // bet placed, waiting for deal
  | "playing"      // it is (or could be) their turn
  | "stood"        // player stood
  | "busted"       // hand > 21
  | "blackjack"    // natural 21 on initial deal
  | "won"
  | "lost"
  | "push"
  | "spectating";  // in the room but not participating this round

export interface Player {
  id: string;
  name: string;
  chips: number;
  hand: Card[];
  bet: number;
  status: PlayerStatus;
  doubled: boolean;
}

// ─── Game state ─────────────────────────────────────────────────
export type GamePhase =
  | "waiting"       // lobby — players joining, no active round
  | "betting"       // bets being placed
  | "playing"       // players taking turns
  | "dealer_turn"   // dealer reveals hole card & hits
  | "round_over";   // results shown, ready for next round

/**
 * Full internal state — the dealer's complete hand is visible here.
 * This lives only inside the Durable Object and is NEVER sent to clients.
 */
export interface GameState {
  phase: GamePhase;
  dealerHand: Card[];
  players: Player[];
  currentPlayerId: string | null;
  message: string;
  round: number;
  deck: Card[];          // remaining cards (not sent to clients)
  bettingDeadline: number | null;  // alarm timestamp for betting window
}

/**
 * Public state — what clients actually receive.
 * The dealer's hole card is replaced with `null` until `dealer_turn` / `round_over`.
 */
export type PublicCard = Card | null;  // null = face-down (hole card)

export interface PublicGameState {
  phase: GamePhase;
  dealerHand: PublicCard[];
  players: Player[];
  currentPlayerId: string | null;
  message: string;
  round: number;
}

// ─── Client → Server messages ───────────────────────────────────
export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "bet"; amount: number }
  | { type: "hit" }
  | { type: "stand" }
  | { type: "double" }
  | { type: "ready" }     // ready for next round (ack round_over)
  | { type: "leave" };

// ─── Server → Client messages ───────────────────────────────────
export type ServerMessage =
  | { type: "state"; state: PublicGameState }
  | { type: "joined"; playerId: string; name: string; chips: number }
  | { type: "player_left"; playerId: string }
  | { type: "error"; message: string };
