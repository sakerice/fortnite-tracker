import type { Tournament, PrizePool } from './types';

const API_URL = 'https://api.start.gg/gql/alpha';

// Start.gg GraphQL: 今後のFortnite大会を取得
// gameId は整数として渡すため変数に含めず文字列補間で埋め込む
function buildQuery(gameId: string) {
  return `
query FortniteTournaments($page: Int!, $perPage: Int!, $afterDate: Timestamp!) {
  tournaments(query: {
    page: $page
    perPage: $perPage
    filter: {
      videogameIds: [${gameId}]
      afterDate: $afterDate
    }
  }) {
    pageInfo {
      total
      totalPages
    }
    nodes {
      id
      name
      slug
      startAt
      endAt
      isOnline
      city
      countryCode
      numAttendees
      events {
        id
        name
        startAt
        numEntrants
        type
      }
    }
  }
}
`;
}

export async function fetchFortniteTournaments(
  apiToken: string,
  gameId = '1842'
): Promise<Tournament[]> {
  const afterDate = Math.floor(Date.now() / 1000); // 現在時刻（Unix秒）
  const all: Tournament[] = [];
  let page = 1;
  let totalPages = 1;
  const perPage = 50;

  const query = buildQuery(gameId);

  while (page <= totalPages && page <= 5) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        query,
        variables: { page, perPage, afterDate },
      }),
    });

    if (!res.ok) {
      throw new Error(`Start.gg API HTTP error: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as any;

    if (json.errors?.length) {
      throw new Error(`Start.gg GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    const result = json.data.tournaments;
    totalPages = result.pageInfo.totalPages;

    for (const node of result.nodes) {
      const events = (node.events ?? []).map((e: any) => ({
        id: String(e.id),
        name: e.name,
        startAt: e.startAt ?? node.startAt,
        numEntrants: e.numEntrants ?? 0,
        type: e.type ?? undefined,
      }));

      // Start.gg APIでは賞金情報はトーナメント名に含まれることが多い
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
