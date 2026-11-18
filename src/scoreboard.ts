/**
 * src/scoreboard.ts — Persistent leaderboard Durable Object.
 *
 * Stores score submissions in SQLite so the leaderboard survives
 * hibernation and restarts.  The poker Table posts here after each
 * showdown; the frontend polls GET /api/scores every 30 s.
 */

import { DurableObject } from "cloudflare:workers";

export class Scoreboard extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS scores (" +
          "game TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL, ts INTEGER NOT NULL" +
        ")"
      );
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_game_score ON scores(game, score DESC)"
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /api/scores  →  { "peggys-poker": [{name, score}, …], … }
    if (path === "/api/scores" && request.method === "GET") {
      const rows = this.ctx.storage.sql.exec(
        "SELECT game, name, score FROM scores ORDER BY score DESC LIMIT 50"
      ).toArray();
      const grouped: Record<string, Array<{ name: string; score: number }>> = {};
      for (const row of rows) {
        const g = row.game as string;
        (grouped[g] ??= []).push({ name: row.name as string, score: row.score as number });
      }
      return Response.json(grouped);
    }

    // POST /api/scores/:game  { name, score }
    if (path.startsWith("/api/scores/") && request.method === "POST") {
      const game = path.split("/")[3] || "unknown";
      let body: { name?: string; score?: number };
      try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
      const name = String(body.name || "Anonymous").slice(0, 16);
      const score = Math.floor(Number(body.score) || 0);
      if (score <= 0) return Response.json({ ok: true });

      this.ctx.storage.sql.exec(
        "INSERT INTO scores (game, name, score, ts) VALUES (?, ?, ?, ?)",
        game, name, score, Date.now()
      );
      // Keep only top 100 per game to avoid unbounded growth
      this.ctx.storage.sql.exec(
        "DELETE FROM scores WHERE game = ? AND id NOT IN " +
        "(SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY game ORDER BY score DESC) AS rn FROM scores WHERE game = ?) WHERE rn <= 100)",
        game, game
      );
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
