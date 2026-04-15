import { fetchFortniteTournaments } from './startgg';
import { fetchFaceitTournaments } from './faceit';
import type { Env, Tournament } from './types';

// KVキー
const KV_TOURNAMENTS = 'tournaments';
const KV_LAST_UPDATED = 'last_updated';

// CORS（PagesのドメインとローカルdevのためALL許可）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

      // 手動大会更新
      case /^\/api\/tournaments\/manual_\w+$/.test(url.pathname) && request.method === 'PUT':
        return handleUpdateTournament(url.pathname, request, env);

      // 手動大会削除
      case /^\/api\/tournaments\/manual_\w+$/.test(url.pathname) && request.method === 'DELETE':
        return handleDeleteTournament(url.pathname, env);

      // 手動リフレッシュ（テスト用）
      case url.pathname === '/api/refresh' && request.method === 'POST':
        ctx.waitUntil(syncFromStartGG(env));
        return json({ message: 'Refresh started' });

      // OGPメタ情報取得（手動追加フォームのURL自動補完用）
      case url.pathname === '/api/fetch-og' && request.method === 'GET':
        return handleFetchOg(url);

      default:
        return new Response('Not Found', { status: 404 });
    }
  },
};

// ============================
// Start.gg → KV 同期
// ============================
async function syncFromStartGG(env: Env) {
  const gameId = env.STARTGG_GAME_ID ?? '1095';

  // 各ソースを独立して取得（1つ失敗しても他に影響しない）
  const [startggResult, faceitResult] = await Promise.allSettled([
    fetchFortniteTournaments(env.STARTGG_API_TOKEN, gameId),
    env.FACEIT_API_KEY
      ? fetchFaceitTournaments(env.FACEIT_API_KEY)
      : Promise.resolve([] as Tournament[]),
  ]);

  const startgg = startggResult.status === 'fulfilled' ? startggResult.value : [];
  const faceit  = faceitResult.status  === 'fulfilled' ? faceitResult.value  : [];

  if (startggResult.status === 'rejected') console.error('[Sync] Start.gg failed:', startggResult.reason);
  if (faceitResult.status  === 'rejected') console.error('[Sync] FACEIT failed:',   faceitResult.reason);

  // 自動収集分を ID でマージ（重複除去）
  const autoById = new Map<string, Tournament>();
  for (const t of [...startgg, ...faceit]) autoById.set(t.id, t);

  // 手動追加分は維持する
  const existing = await loadTournaments(env);
  const manuals = existing.filter(t => t.source === 'manual');

  const merged = [...autoById.values(), ...manuals];
  await env.TOURNAMENTS_KV.put(KV_TOURNAMENTS, JSON.stringify(merged));
  await env.TOURNAMENTS_KV.put(KV_LAST_UPDATED, new Date().toISOString());

  console.log(
    `[Sync] Done: startgg=${startgg.length} faceit=${faceit.length} manual=${manuals.length} total=${merged.length}`
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

  // 開催日昇順。startAt=0（日時未定）は末尾
  tournaments.sort((a, b) => {
    if (a.startAt === 0 && b.startAt === 0) return 0;
    if (a.startAt === 0) return 1;
    if (b.startAt === 0) return -1;
    return a.startAt - b.startAt;
  });

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
// PUT /api/tournaments/:id（手動追加分のみ更新可）
// ============================
async function handleUpdateTournament(pathname: string, request: Request, env: Env): Promise<Response> {
  const id = pathname.split('/').pop()!;
  const existing = await loadTournaments(env);
  const idx = existing.findIndex(t => t.id === id);

  if (idx === -1) return json({ error: '大会が見つかりません' }, 404);
  if (existing[idx].source !== 'manual') return json({ error: '手動追加した大会のみ編集できます' }, 403);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.name || !body.url || !body.startAt) {
    return json({ error: 'name, url, startAt は必須です' }, 400);
  }
  const startTs = Math.floor(new Date(body.startAt).getTime() / 1000);
  if (isNaN(startTs)) return json({ error: 'startAt の日付形式が不正です' }, 400);

  existing[idx] = {
    ...existing[idx],
    name: String(body.name).slice(0, 200),
    url: String(body.url).slice(0, 500),
    startAt: startTs,
    endAt: body.endAt ? Math.floor(new Date(body.endAt).getTime() / 1000) : 0,
    isOnline: Boolean(body.isOnline),
    city: body.city ? String(body.city).slice(0, 100) : undefined,
  };

  await env.TOURNAMENTS_KV.put(KV_TOURNAMENTS, JSON.stringify(existing));
  return json({ success: true, tournament: existing[idx] });
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
// GET /api/fetch-og?url=<encoded>
// 指定URLのOGP/metaタグを取得して大会情報を推定する
// ============================
async function handleFetchOg(reqUrl: URL): Promise<Response> {
  const targetUrl = reqUrl.searchParams.get('url');
  if (!targetUrl) return json({ error: 'url parameter required' }, 400);

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }

  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FortniteTrackerBot/1.0)',
        Accept: 'text/html',
      },
      redirect: 'follow',
      // @ts-ignore - Cloudflare Workers 独自オプション
      cf: { cacheTtl: 300 },
    });

    if (!res.ok) return json({ error: `Fetch failed: ${res.status}` }, 502);

    const html = await res.text();

    const getMeta = (prop: string): string => {
      const m =
        html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'));
      return m ? decodeHtmlEntities(m[1].trim()) : '';
    };

    const getTitle = (): string => {
      return (
        getMeta('title') ||
        (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? '')
      );
    };

    // 日時の推定（og:description や本文から yyyy-mm-dd / yyyy/mm/dd パターンを探す）
    const guessDate = (): string => {
      const text = html.replace(/<[^>]+>/g, ' ');
      const m = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (m) {
        const [, y, mo, d] = m;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00`;
      }
      return '';
    };

    return json({
      title: getTitle(),
      description: getMeta('description'),
      image: getMeta('image'),
      siteName: getMeta('site_name'),
      guessedDate: guessDate(),
    });
  } catch (e) {
    return json({ error: `Fetch error: ${String(e)}` }, 502);
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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
