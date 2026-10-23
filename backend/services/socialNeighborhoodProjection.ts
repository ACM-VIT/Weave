/** Viewer-scoped candidate evidence from existing public surfaces and own seeds.
 * Raw cross-user saves/collections and discoverable unlisted boards are excluded.
 * Pass rows through the social projection's distinct-support and source/owner caps.
 */
export interface SocialNeighborhoodReader {
  query(text: string, parameters: readonly string[]): Promise<Record<string, unknown>[]>;
}
export interface SocialNeighborhoodRow {
  repo_id: string;
  owner_github_id: string;
  source: 'followed_like' | 'co_like' | 'board_topic' | 'adjacent_interest';
  actor_key: string;
  star_count: number;
  repo_status: string;
  viewer_can_access: boolean;
  actor_active: boolean;
  signal_allowed: boolean;
}
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One read snapshot: revocation/visibility cannot change between source queries.
// Bounds precede fanout:50 followed/co-like actors x20 likes each;50 public
// boards x20 items;20 topics x10 neighbor repos xat most20 own positive seeds.
// Membership samples are deterministic and may underfill rather than scan unbounded neighborhoods.
export const PUBLIC_SOCIAL_NEIGHBORHOODS_SQL = `
WITH viewer AS MATERIALIZED (
  SELECT user_id FROM app.users WHERE user_id=$1::uuid AND status='active'
), positive_rows AS (
  (SELECT reaction.repo_id,reaction.updated_at AS occurred_at
  FROM app.reactions reaction WHERE reaction.user_id IN (SELECT user_id FROM viewer) AND reaction.reaction='like'
  ORDER BY reaction.updated_at DESC,reaction.repo_id LIMIT 20)
  UNION ALL
  (SELECT saved.repo_id,saved.created_at FROM app.saves saved
  WHERE saved.user_id IN (SELECT user_id FROM viewer)
  ORDER BY saved.created_at DESC,saved.repo_id LIMIT 20)
), positives AS MATERIALIZED (
  SELECT positive.repo_id,max(positive.occurred_at) AS occurred_at
  FROM positive_rows positive JOIN app.repos repo USING(repo_id)
  WHERE repo.status='active' GROUP BY positive.repo_id ORDER BY max(positive.occurred_at) DESC,positive.repo_id LIMIT 20
), followed AS MATERIALIZED (
  SELECT followed.user_id,follow.created_at
  FROM app.follows follow JOIN app.users followed ON followed.user_id=follow.following_id AND followed.status='active'
  WHERE follow.follower_id IN (SELECT user_id FROM viewer)
  ORDER BY follow.created_at DESC,followed.user_id LIMIT 50
), like_rows AS (
  SELECT candidate.repo_id,'followed_like'::text AS source,'public-like:'||followed.user_id::text AS actor_key
  FROM followed CROSS JOIN LATERAL (
    SELECT reaction.repo_id FROM app.reactions reaction JOIN app.repos repo USING(repo_id)
    WHERE reaction.user_id=followed.user_id AND reaction.reaction='like' AND repo.status='active'
      AND repo.owner_github_id>0 AND NOT EXISTS(SELECT 1 FROM positives p WHERE p.repo_id=repo.repo_id)
    ORDER BY reaction.updated_at DESC,reaction.repo_id LIMIT 20
  ) candidate
), co_users AS MATERIALIZED (
  SELECT neighbor.user_id,count(DISTINCT seed.repo_id) AS overlap
  FROM positives seed CROSS JOIN LATERAL (
    SELECT reaction.user_id FROM app.reactions reaction
    WHERE reaction.repo_id=seed.repo_id AND reaction.reaction='like'
    ORDER BY reaction.user_id LIMIT 100
  ) neighbor JOIN app.users actor ON actor.user_id=neighbor.user_id AND actor.status='active'
  WHERE neighbor.user_id NOT IN (SELECT user_id FROM viewer)
  GROUP BY neighbor.user_id ORDER BY count(DISTINCT seed.repo_id) DESC,neighbor.user_id LIMIT 50
), co_rows AS (
  SELECT candidate.repo_id,'co_like'::text AS source,'public-like:'||actor.user_id::text AS actor_key
  FROM co_users actor CROSS JOIN LATERAL (
    SELECT reaction.repo_id FROM app.reactions reaction JOIN app.repos repo USING(repo_id)
    WHERE reaction.user_id=actor.user_id AND reaction.reaction='like' AND repo.status='active'
      AND repo.owner_github_id>0 AND NOT EXISTS(SELECT 1 FROM positives p WHERE p.repo_id=repo.repo_id)
    ORDER BY reaction.updated_at DESC,reaction.repo_id LIMIT 20
  ) candidate
), public_boards AS MATERIALIZED (
  SELECT board.board_id,board.user_id,count(DISTINCT seed.repo_id) AS overlap
  FROM positives seed CROSS JOIN LATERAL (
    SELECT member.board_id FROM app.board_repos member WHERE member.repo_id=seed.repo_id
    ORDER BY member.board_id LIMIT 100
  ) member JOIN app.boards board ON board.board_id=member.board_id
  JOIN app.users owner ON owner.user_id=board.user_id AND owner.status='active'
  WHERE board.visibility='public' AND board.user_id NOT IN (SELECT user_id FROM viewer)
  GROUP BY board.board_id,board.user_id ORDER BY count(DISTINCT seed.repo_id) DESC,board.board_id LIMIT 50
), board_rows AS (
  SELECT candidate.repo_id,'board_topic'::text AS source,'public-board-owner:'||board.user_id::text AS actor_key
  FROM public_boards board CROSS JOIN LATERAL (
    SELECT member.repo_id FROM app.board_repos member JOIN app.repos repo USING(repo_id)
    WHERE member.board_id=board.board_id AND repo.status='active' AND repo.owner_github_id>0
      AND NOT EXISTS(SELECT 1 FROM positives p WHERE p.repo_id=repo.repo_id)
    ORDER BY member.added_at DESC,member.repo_id LIMIT 20
  ) candidate
), seed_topics AS MATERIALIZED (
  SELECT topic.topic_id,array_agg(DISTINCT seed.repo_id ORDER BY seed.repo_id) AS seeds
  FROM positives seed CROSS JOIN LATERAL (
    SELECT topic_id FROM app.repo_topics WHERE repo_id=seed.repo_id ORDER BY topic_id LIMIT 10
  ) topic
  GROUP BY topic.topic_id ORDER BY count(DISTINCT seed.repo_id) DESC,topic.topic_id LIMIT 20
), adjacent_rows AS (
  SELECT candidate.repo_id,'adjacent_interest'::text AS source,'own-positive-seed:'||seed.repo_id::text AS actor_key
  FROM seed_topics topic CROSS JOIN LATERAL (
    SELECT repo.repo_id FROM (
      SELECT membership.repo_id FROM app.repo_topics membership WHERE membership.topic_id=topic.topic_id
      ORDER BY membership.repo_id LIMIT 100
    ) member JOIN app.repos repo USING(repo_id)
    WHERE repo.status='active' AND repo.owner_github_id>0
      AND NOT EXISTS(SELECT 1 FROM positives p WHERE p.repo_id=repo.repo_id)
    ORDER BY repo.updated_at DESC,repo.repo_id LIMIT 10
  ) candidate CROSS JOIN LATERAL unnest(topic.seeds) AS seed(repo_id)
), signals AS (
  SELECT * FROM like_rows UNION ALL SELECT * FROM co_rows UNION ALL SELECT * FROM board_rows UNION ALL SELECT * FROM adjacent_rows
)
SELECT signal.repo_id,repo.owner_github_id::text AS owner_github_id,signal.source,signal.actor_key,stats.star_count
FROM signals signal JOIN app.repos repo USING(repo_id)
CROSS JOIN LATERAL (
  SELECT star_count FROM app.repo_stat_snapshots WHERE repo_id=repo.repo_id ORDER BY observed_at DESC LIMIT 1
) stats
WHERE repo.status='active' AND repo.owner_github_id>0
ORDER BY signal.source,signal.repo_id,signal.actor_key LIMIT 10001
`;

export async function loadSocialNeighborhoodRows(reader: SocialNeighborhoodReader, viewerUserId: string): Promise<SocialNeighborhoodRow[]> {
  if (!canonicalUuid.test(viewerUserId)) throw new Error('Social neighborhood viewer must be a canonical UUID.');
  const rows = await reader.query(PUBLIC_SOCIAL_NEIGHBORHOODS_SQL, [viewerUserId]);
  if (rows.length > 10000) throw new Error('Social neighborhood source exceeded its row budget.');
  return rows.map(row => {
    if (typeof row.repo_id !== 'string' || !canonicalUuid.test(row.repo_id)
      || typeof row.owner_github_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.owner_github_id)
      || BigInt(row.owner_github_id)>9223372036854775807n
      || typeof row.source !== 'string' || !['followed_like','co_like','board_topic','adjacent_interest'].includes(row.source)
      || typeof row.actor_key !== 'string' || row.actor_key.length>128
      || !/^(public-like|public-board-owner|own-positive-seed):[0-9a-f-]{36}$/.test(row.actor_key)
      || !canonicalUuid.test(row.actor_key.slice(row.actor_key.indexOf(':')+1))
      || !row.actor_key.startsWith(({ followed_like:'public-like:', co_like:'public-like:', board_topic:'public-board-owner:',
        adjacent_interest:'own-positive-seed:' } as Record<string,string>)[String(row.source)]!)
      || typeof row.star_count !== 'number' || !Number.isSafeInteger(row.star_count) || row.star_count<0) {
      throw new Error('Invalid canonical social neighborhood evidence.');
    }
    return { repo_id:row.repo_id,owner_github_id:row.owner_github_id,source:row.source as SocialNeighborhoodRow['source'],
      actor_key:row.actor_key,star_count:row.star_count,
      repo_status:'active',viewer_can_access:true,actor_active:true,signal_allowed:true };
  });
}
