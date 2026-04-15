import type { Tournament, PrizePool } from './types';

const API_URL = 'https://api.start.gg/gql/alpha';

// gameId は整数として渡すため変数に含めず文字列補間で埋め込む
function buildQuery(gameId: string, countryCode?: string) {
  const countryFilter = countryCode ? `countryCode: "${countryCode}"` : '';
  return `
query FortniteTournaments($page: Int!, $perPage: Int!, $afterDate: Timestamp!) {
  tournaments(query: {
    page: $page
    perPage: $perPage
    filter: {
      videogameIds: [${gameId}]
      afterDate: $afterDate
      ${countryFilter}
    }
  }) {
    pageInfo { total totalPages }
    nodes {
      id name slug startAt endAt isOnline
      city countryCode numAttendees
      events {
        id name startAt numEntrants type
      }
    }
  }
}
`;
}

// 1クエリ分のページネーション取得
async function fetchPages(
  apiToken: string,
  query: string,
  afterDate: number,
  label: string
): Promise<Tournament[]> {
  const all: Tournament[] = [];
  let page = 1;
  let totalPages = 1;
  const perPage = 50;

  while (page <= totalPages && page <= 10) {
    // Start.gg は複雑なクエリでレート制限がかかることがあるため間隔を空ける
    if (page > 1) await new Promise(r => setTimeout(r, 1000));

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ query, variables: { page, perPage, afterDate } }),
    });

    if (!res.ok) {
      console.error(`[Start.gg ${label}] HTTP ${res.status} on page ${page}`);
      break;
    }

    const json = (await res.json()) as any;

    if (json.errors?.length) {
      console.error(`[Start.gg ${label}] GraphQL error: ${JSON.stringify(json.errors)}`);
      break;
    }

    const result = json.data.tournaments;
    totalPages = result.pageInfo.totalPages;
    console.log(`[Start.gg ${label}] page ${page}/${totalPages}, ${result.nodes.length} nodes`);

    for (const node of result.nodes) {
      const events = (node.events ?? []).map((e: any) => ({
        id: String(e.id),
        name: e.name,
        startAt: e.startAt ?? node.startAt,
        numEntrants: e.numEntrants ?? 0,
        type: e.type ?? undefined,
      }));

      const prizePools: PrizePool[] = [];

      all.push({
        id: `startgg_${node.id}`,
        name: node.name,
        url: `https://www.start.gg/${node.slug}`,
        startAt: node.startAt,
        endAt: node.endAt ?? 0,
        isOnline: node.isOnline ?? false,
        city: node.city ?? undefined,
        countryCode: node.countryCode ?? undefined,
        numAttendees: node.numAttendees ?? 0,
        events,
        prizePools,
        source: 'startgg',
        addedAt: Date.now(),
      });
    }

    page++;
  }

  return all;
}

export async function fetchFortniteTournaments(
  apiToken: string,
  gameId = '1095'
): Promise<Tournament[]> {
  // 30日前まで遡る（開始済みでも進行中の大会を取りこぼさないため）
  const afterDate = Math.floor((Date.now() - 30 * 86_400_000) / 1000);

  // クエリ1: グローバル全件
  const globalQuery = buildQuery(gameId);
  const globalResults = await fetchPages(apiToken, globalQuery, afterDate, 'global');

  // クエリ2: 日本絞り込み（グローバルで拾えていないものを補完）
  const japanQuery = buildQuery(gameId, 'JP');
  const japanResults = await fetchPages(apiToken, japanQuery, afterDate, 'JP');

  // 重複除去（IDベース）
  const seen = new Set(globalResults.map(t => t.id));
  const unique = [
    ...globalResults,
    ...japanResults.filter(t => !seen.has(t.id)),
  ];

  console.log(
    `[Start.gg] global=${globalResults.length} JP-only=${japanResults.filter(t => !seen.has(t.id)).length} total=${unique.length}`
  );

  return unique;
}
