/**
 * src/blackjack/Blackjack.tsx — Multiplayer Blackjack table UI.
 *
 * Visual style matches Peggy's Poker House: dark green felt, orange
 * accents, white cards with suit symbols.  Uses the useBlackjack hook
 * to talk to the BlackjackRoom Durable Object via WebSocket.
 */

import { useEffect, useState } from "react";
import { useBlackjack } from "./useBlackjack";
import type { Card, PublicCard, Player, GamePhase } from "../shared/types";

// ─── Card rendering helpers ─────────────────────────────────────
const SUIT_SYMBOL: Record<string, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
const RANK_LABEL: Record<string, string> = { A: "A", "10": "10", J: "J", Q: "Q", K: "K" };

function cardStr(c: Card): string {
  return `${RANK_LABEL[c.rank] ?? c.rank}${SUIT_SYMBOL[c.suit]}`;
}
function isRed(c: Card): boolean {
  return c.suit === "hearts" || c.suit === "diamonds";
}

function handTotal(hand: Card[]): string {
  if (hand.length === 0) return "";
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.rank === "A") { aces++; total += 11; }
    else if (["K", "Q", "J", "10"].includes(c.rank)) total += 10;
    else total += parseInt(c.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return String(total);
}

// ─── Small UI atoms ─────────────────────────────────────────────
function CardView({ card, hidden }: { card: PublicCard; hidden?: boolean }) {
  if (!card || hidden) {
    return (
      <span style={{
        display: "inline-block", background: "#1a3a2a", color: "#3ea37a",
        border: "1px solid #2f7a5c", borderRadius: 6, padding: "4px 8px",
        margin: 2, fontWeight: 700, minWidth: 28, textAlign: "center",
      }}>
        🂠
      </span>
    );
  }
  return (
    <span style={{
      display: "inline-block", background: "#fff", color: isRed(card) ? "#c00" : "#111",
      borderRadius: 6, padding: "4px 8px", margin: 2, fontWeight: 700, minWidth: 28, textAlign: "center",
    }}>
      {cardStr(card)}
    </span>
  );
}

function Hand({ cards, reveal }: { cards: PublicCard[]; reveal: boolean }) {
  return (
    <div style={{ minHeight: 30 }}>
      {cards.length === 0
        ? <span style={{ color: "#6b8a7a" }}>—</span>
        : cards.map((c, i) => <CardView key={i} card={c} hidden={!reveal && i === 1 && c === null} />)}
      {reveal && cards.length > 0 && cards[0] && cards[1] && (
        <span style={{ marginLeft: 6, color: "#ff9b57", fontWeight: 700 }}>
          {handTotal(cards.filter((c): c is Card => c !== null))}
        </span>
      )}
    </div>
  );
}

function Btn({ label, onClick, disabled, primary }: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 44, padding: "0 16px", margin: 4, borderRadius: 22, border: 0,
        background: disabled ? "#444" : primary ? "#ff7a3c" : "#2f7a5c",
        color: disabled ? "#888" : "#111", fontWeight: 700, cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

const PHASE_LABEL: Record<GamePhase, string> = {
  waiting: "Waiting Room",
  betting: "Place Your Bets",
  playing: "Player Turns",
  dealer_turn: "Dealer's Turn",
  round_over: "Round Over",
};

// ─── Main component ─────────────────────────────────────────────
export default function Blackjack() {
  const { state, playerId, connected, send } = useBlackjack("main");
  const [name, setName] = useState(() => localStorage.getItem("bj_name") || "");
  const [savedName, setSavedName] = useState(false);
  const [betAmount, setBetAmount] = useState(50);
  const [scores, setScores] = useState<Array<{ name: string; score: number }>>([]);

  // Poll leaderboard
  useEffect(() => {
    const fetchScores = () =>
      fetch("/api/scores").then(r => r.json()).then(d => {
        setScores(d["peggys-poker"] || []);
      }).catch(() => {});
    fetchScores();
    const t = setInterval(fetchScores, 30000);
    return () => clearInterval(t);
  }, []);

  // Auto-join when name is saved
  useEffect(() => {
    if (savedName && name && connected) send({ type: "join", name });
  }, [savedName, name, connected]);

  if (!connected) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: "#8dff6a", fontFamily: "system-ui, sans-serif" }}>
        Connecting to Blackjack table…
      </div>
    );
  }

  // Name entry screen
  if (!savedName) {
    return (
      <div style={{ maxWidth: 440, margin: "40px auto", fontFamily: "system-ui, sans-serif" }}>
        <div style={{
          background: "#102a20", border: "1px solid #2f7a5c", borderRadius: 16, padding: 20,
        }}>
          <h2 style={{ color: "#ff9b57", marginTop: 0 }}>Peggy's Blackjack</h2>
          <p style={{ color: "#9a977a" }}>Enter a name to take a seat.</p>
          <input
            placeholder="Your name"
            maxLength={16}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && name.trim()) setSavedName(true); }}
            style={{
              minHeight: 44, padding: "0 12px", borderRadius: 22, border: "1px solid #3ea37a",
              background: "#071510", color: "#fff", width: "calc(100% - 28px)", marginBottom: 8,
            }}
          />
          <Btn label="Take a Seat" primary onClick={() => name.trim() && setSavedName(true)} disabled={!name.trim()} />
        </div>
      </div>
    );
  }

  if (!state) return null;

  const me = state.players.find(p => p.id === playerId);
  const isMyTurn = state.phase === "playing" && state.currentPlayerId === playerId;
  const dealerReveal = state.phase === "dealer_turn" || state.phase === "round_over";
  const canBet = state.phase === "waiting" || state.phase === "betting" || state.phase === "round_over";
  const canAct = isMyTurn && me?.status === "playing";

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: 12, fontFamily: "system-ui, sans-serif", color: "#f3efe6" }}>
      {/* Header */}
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <h1 style={{ color: "#ff9b57", margin: "0 0 4px", fontSize: "1.6rem" }}>Peggy's Blackjack</h1>
        <span style={{ color: "#8dff6a", fontSize: 13 }}>
          Round {state.round} · {PHASE_LABEL[state.phase]}
        </span>
      </div>

      {/* Status message */}
      <div style={{
        background: "#102a20", border: "1px solid #2f7a5c", borderRadius: 12,
        padding: "10px 14px", margin: "8px 0", textAlign: "center", color: "#ff9b57", fontWeight: 600,
      }}>
        {state.message}
      </div>

      {/* Dealer */}
      <div style={{
        background: "#071510", border: "1px solid #2f7a5c", borderRadius: 16, padding: 14, margin: "8px 0",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <strong style={{ color: "#ff9b57" }}>Dealer</strong>
          <span style={{ color: "#6b8a7a", fontSize: 13 }}>
            {dealerReveal && state.dealerHand.length > 0
              ? `${handTotal(state.dealerHand.filter((c): c is Card => c !== null))}`
              : ""}
          </span>
        </div>
        <Hand cards={state.dealerHand} reveal={dealerReveal} />
      </div>

      {/* Player seats */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, margin: "8px 0",
      }}>
        {state.players.map(p => {
          const isMe = p.id === playerId;
          const isCurrent = state.currentPlayerId === p.id;
          return (
            <div key={p.id} style={{
              background: "#071510", borderRadius: 12, padding: 10, minHeight: 80,
              border: isCurrent ? "2px solid #ff7a3c" : "1px solid #2f7a5c",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>{p.name}{isMe ? " (you)" : ""}</strong>
                {isCurrent && <span style={{ color: "#ff7a3c", fontSize: 11 }}>TURN</span>}
              </div>
              <div style={{ fontSize: 13, color: "#9a977a" }}>
                {p.chips} chips{p.bet > 0 ? ` · bet ${p.bet}${p.doubled ? " (doubled)" : ""}` : ""}
              </div>
              <div style={{ fontSize: 12, color: "#6b8a7a", marginTop: 2 }}>
                {p.status === "spectating" ? "spectating"
                  : p.status === "busted" ? "bust"
                  : p.status === "blackjack" ? "Blackjack!"
                  : p.status === "won" ? "won"
                  : p.status === "lost" ? "lost"
                  : p.status === "push" ? "push"
                  : p.status === "stood" ? "stood"
                  : ""}
              </div>
              {p.hand.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <Hand cards={p.hand} reveal={true} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Controls */}
      <div style={{
        background: "#102a20", border: "1px solid #2f7a5c", borderRadius: 16, padding: 14, margin: "8px 0",
      }}>
        {me?.status === "spectating" ? (
          <p style={{ color: "#9a977a", margin: 0 }}>Table is full. You're spectating.</p>
        ) : (
          <>
            {/* Betting controls */}
            {canBet && (
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                <input
                  type="number" min={1} max={me?.chips ?? 0} value={betAmount}
                  onChange={e => setBetAmount(Number(e.target.value))}
                  style={{
                    minHeight: 44, width: 90, padding: "0 12px", borderRadius: 22,
                    border: "1px solid #3ea37a", background: "#071510", color: "#fff",
                  }}
                />
                <Btn label={`Bet ${betAmount}`} primary onClick={() => send({ type: "bet", amount: betAmount })}
                  disabled={!me || me.chips <= 0 || betAmount < 1} />
                {[25, 50, 100, 250].map(v => (
                  <Btn key={v} label={`+${v}`} onClick={() => setBetAmount(a => Math.min(a + v, me?.chips ?? 0))} />
                ))}
              </div>
            )}

            {/* Playing controls */}
            {canAct && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                <Btn label="Hit" primary onClick={() => send({ type: "hit" })} />
                <Btn label="Stand" onClick={() => send({ type: "stand" })} />
                <Btn label="Double" onClick={() => send({ type: "double" })}
                  disabled={me.hand.length !== 2 || me.chips < me.bet} />
              </div>
            )}

            {/* Round over */}
            {state.phase === "round_over" && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                <Btn label="Ready for Next Round" primary onClick={() => send({ type: "ready" })} />
                <Btn label="Bet Again" onClick={() => send({ type: "bet", amount: betAmount })} />
              </div>
            )}

            {/* Waiting / not your turn */}
            {state.phase === "playing" && !isMyTurn && me?.status === "playing" && (
              <p style={{ color: "#9a977a", margin: 0 }}>Waiting for your turn…</p>
            )}
            {state.phase === "playing" && me && me.status !== "playing" && me.status !== "spectating" && (
              <p style={{ color: "#9a977a", margin: 0 }}>You're done this round. Waiting for others.</p>
            )}
            {state.phase === "dealer_turn" && (
              <p style={{ color: "#9a977a", margin: 0 }}>Dealer is playing…</p>
            )}
          </>
        )}
      </div>

      {/* Leaderboard */}
      {scores.length > 0 && (
        <div style={{
          background: "#102a20", border: "1px solid #2f7a5c", borderRadius: 16, padding: 14, margin: "8px 0",
        }}>
          <h3 style={{ color: "#ff9b57", marginTop: 0 }}>🏆 Top Hands</h3>
          {scores.map((s, i) => (
            <div key={i} style={{
              display: "flex", justifyContent: "space-between", padding: "4px 0",
              borderBottom: i < scores.length - 1 ? "1px solid #1a3a2a" : "none",
            }}>
              <span style={{ color: "#ff9b57", fontWeight: 700, width: 24 }}>{i + 1}</span>
              <span style={{ flex: 1, padding: "0 8px" }}>{s.name}</span>
              <span style={{ fontWeight: 700 }}>{s.score} chips</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
