/**
 * src/blackjack/useBlackjack.ts — React hook that manages the WebSocket
 * connection to the BlackjackRoom Durable Object and exposes the game
 * state plus a `send` helper for ClientMessage actions.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type { ClientMessage, PublicGameState } from "../shared/types";

export interface BlackjackHook {
  state: PublicGameState | null;
  playerId: string | null;
  connected: boolean;
  send: (msg: ClientMessage) => void;
}

export function useBlackjack(room = "main"): BlackjackHook {
  const [state, setState] = useState<PublicGameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?game=blackjack&room=${encodeURIComponent(room)}`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "joined") setPlayerId(msg.playerId);
        else if (msg.type === "state") setState(msg.state);
        else if (msg.type === "error") console.warn("[blackjack]", msg.message);
      } catch { /* ignore malformed */ }
    };

    return () => { ws.close(); wsRef.current = null; };
  }, [room]);

  return { state, playerId, connected, send };
}
