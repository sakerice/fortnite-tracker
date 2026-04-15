import { fetchFortniteTournaments } from './startgg';
import type { Env, Tournament } from './types';

// KVキー
const KV_TOURNAMENTS = 'tournaments';
const KV_LAST_UPDATED = 'last_updated';

// CORS（PagesのドメインとローカルdevのためALL許可）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  // ============================
  // Cron Trigger（6時間ごと自動取得）
  // ============================
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    console.log('[Cron] Start.gg fetch started');
    await syncFromStartGG(env);
  },

  // ============================
  // HTTP リクエストハンドラ
  // ============================
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    switch (true) {
      // 大会一覧取得（フィルター対応）
      case url.pathname === '/api/tournaments' && request.method === 'GET':
        return handleGetTournaments(url, env);

      // 手動大会追加
      case url.pathname === '/api/tournaments' && request.method === 'POST':
        return handleAddTournament(request, env);

      // 手動大会削除
      case /^\/api\/tournaments\/manual_\w+$/.test(url.pathname) && request.method === 'DELETE':
        return handleDeleteTournament(url.pathname, env);

      // 手動リフレッシュ（テスト用）
      case url.pathname === '/api/refresh' && request.method === 'POST':
        ctx.waitUntil(syncFromStartGG(env));
        return json({ message: 'Refresh started' });

      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

// ============================
// Start.gg → KV 同期
// ============================
async function syncFromStartGG(env: Env) {
  const gameId = env.STARTGG_GAME_ID ?? '1842';
  const freshTournaments = await fetchFortniteTournaments(env.STARTGG_API_TOKEN, gameId);

  // 手動追加分は維持する
  const existing = await loadTournaments(env);
  const manuals = existing.filter(t => t.source === 'manual');

  const merged = [...freshTournaments, ...manuals];
  await env.TOURNAMENTS_KV.put(KV_TOURNAMENTS, JSON.stringify(merged));
  await env.TOURNAMENTS_KV.put(KV_LAST_UPDATED, new Date().toISOString());

  console.log(
    `[Sync] Done: ${freshTournaments.length} from Start.gg + ${manuals.length} manual = ${merged.length} total`
  );
}

// ============================
// GET /api/tournaments
// クエリパラメータ:
//   isOnline=true|false
//   hasPrize=true
//   maxAge=17  （この年齢以下が参加できる大会を表示）
//   from=YYYY-MM-DD
// ============================
async function handleGetTournaments(url: URL, env: Env): Promise<Response> {
  let tournaments = await loadTournaments(env);
  const lastUpdated = await env.TOURNAMENTS_KV.get(KV_LAST_UPDATED);

  // フィルター: オンライン/オフライン
  const isOnlineParam = url.searchParams.get('isOnline');
  if (isOnlineParam !== null) {
    const wantOnline = isOnlineParam === 'true';
    tournaments = tournaments.filter(t => t.isOnline === wantOnline);
  }

  // フィルター: 賞金あり
  if (url.searchParams.get('hasPrize') === 'true') {
    tournaments = tournaments.filter(t =>
      t.prizePools.some(p => p.totalAmount > 0)
    );
  }

  // フィルター: 年齢（指定年齢が参加できるイベントを持つ大会のみ）
  const maxAgeParam = url.searchParams.get('maxAge');
  if (maxAgeParam) {
    const age = parseInt(maxAgeParam, 10);
    tournaments = tournaments.filter(t =>
      t.events.some(e => e.minAge == null || e.minAge <= age)
    );
  }

  // フィルター: 開催日（以降）
  const fromParam = url.searchParams.get('from');
  if (fromParam) {
    const fromTs = Math.floor(new Date(fromParam).getTime() / 1000);
    tournaments = tournaments.filter(t => t.startAt >= fromTs);
  }

  // 開催日昇順でソート
  tournaments.sort((a, b) => a.startAt - b.startAt);

  return json({ tournaments, total: tournaments.length, lastUpdated });
}

// ============================
// POST /api/tournaments（手動追加）
// Body: { name, url, startAt, endAt?, isOnline?, city?, note? }
// ============================
async function handleAddTournament(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.name || !body.url || !body.startAt) {
    return json({ error: 'name, url, startAt は必須です' }, 400);
  }

  const startTs = Math.floor(new Date(body.startAt).getTime() / 1000);
  if (isNaN(startTs)) {
    return json({ error: 'startAt の日付形式が不正です（例: 2025-08-01T10:00）' }, 400);
  }

  const tournament: Tournament = {
    id: `manual_${Date.now()}`,
    name: String(body.name).slice(0, 200),
    url: String(body.url).slice(0, 500),
    startAt: startTs,
    endAt: body.endAt ? Math.floor(new Date(body.endAt).getTime() / 1000) : 0,
    isOnline: Boolean(body.isOnline),
    city: body.city ? String(body.city).slice(0, 100) : undefined,
    countryCode: body.countryCode ?? undefined,
    numAttendees: 0,
    events: [],
    prizePools: [],
    source: 'manual',
    addedAt: Date.now(),
  };

  const existing = await loadTournaments(env);
  existing.push(tournament);
  await env.TOURNAMENTS_KV.put(KV_TOURNAMENTS, JSON.stringify(existing));

  return json({ success: true, tournament }, 201);
}

// ============================
// DELETE /api/tournaments/:id（手動追加分のみ削除可）
// ============================
async function handleDeleteTournament(pathname: string, env: Env): Promise<Response> {
  const id = pathname.split('/').pop()!;
  const existing = await loadTournaments(env);
  const target = existing.find(t => t.id === id);

  if (!target) return json({ error: '大会が見つかりません' }, 404);
  if (target.source !== 'manual') return json({ error: '手動追加した大会のみ削除できます' }, 403);

  const updated = existing.filter(t => t.id !== id);
  await env.TOURNAMENTS_KV.put(KV_TOURNAMENTS, JSON.stringify(updated));
  return json({ success: true });
}

// ============================
// ユーティリティ
// ============================
async function loadTournaments(env: Env): Promise<Tournament[]> {
  const raw = await env.TOURNAMENTS_KV.get(KV_TOURNAMENTS);
  return raw ? (JSON.parse(raw) as Tournament[]) : [];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
