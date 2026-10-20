import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const client = postgres(databaseUrl, { max: 1, prepare: false });
const report = { started_at: new Date().toISOString(), counts: {} as Record<string, number>, rejects: [] as string[], checksums: {} as Record<string, string> };

async function count(name: string, query: ReturnType<typeof client.unsafe>) {
  const rows = await query;
  report.counts[name] = Number(rows[0]?.count ?? 0);
}

try {
  await client.begin(async (tx) => {
    await tx`
      INSERT INTO app.users (user_id,username,full_name,bio,github_id,github_handle,avatar_url,status,created_at)
      SELECT user_id,username,full_name,bio,github_id,github_handle,avatar_url,'active',COALESCE(created_at,now()) FROM public.users
      ON CONFLICT (user_id) DO UPDATE SET username=EXCLUDED.username,full_name=EXCLUDED.full_name,bio=EXCLUDED.bio,
        github_id=EXCLUDED.github_id,github_handle=EXCLUDED.github_handle,avatar_url=EXCLUDED.avatar_url,updated_at=now()
      WHERE (app.users.username,app.users.full_name,app.users.bio,app.users.github_id,app.users.github_handle,app.users.avatar_url)
        IS DISTINCT FROM
        (EXCLUDED.username,EXCLUDED.full_name,EXCLUDED.bio,EXCLUDED.github_id,EXCLUDED.github_handle,EXCLUDED.avatar_url)
    `;
    await tx`
      INSERT INTO app.user_stats (user_id,followers_count,following_count,likes_given_count,saved_repos_count)
      SELECT legacy.user_id,COALESCE(legacy.followers_count,0),COALESCE(legacy.following_count,0),
        (SELECT count(*)::int FROM public.activity WHERE user_id=legacy.user_id AND likelihood_count=1),
        (SELECT count(*)::int FROM public.activity WHERE user_id=legacy.user_id AND is_saved)
      FROM public.users legacy ON CONFLICT (user_id) DO UPDATE SET
        followers_count=EXCLUDED.followers_count,following_count=EXCLUDED.following_count,
        likes_given_count=EXCLUDED.likes_given_count,saved_repos_count=EXCLUDED.saved_repos_count,updated_at=now()
      WHERE (app.user_stats.followers_count,app.user_stats.following_count,app.user_stats.likes_given_count,app.user_stats.saved_repos_count)
        IS DISTINCT FROM
        (EXCLUDED.followers_count,EXCLUDED.following_count,EXCLUDED.likes_given_count,EXCLUDED.saved_repos_count)
    `;
    await tx`INSERT INTO app.user_feed_state (user_id) SELECT user_id FROM app.users ON CONFLICT DO NOTHING`;
    await tx`
      INSERT INTO app.topics (slug,display_name)
      SELECT lower(trim(value)),min(trim(value)) FROM (
        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(interests)='array' THEN interests ELSE '[]'::jsonb END) AS value FROM public.users
        UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(skills)='array' THEN skills ELSE '[]'::jsonb END) FROM public.users
        UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(tech_stack)='array' THEN tech_stack ELSE '[]'::jsonb END) FROM public.users
        UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(topics)='array' THEN topics ELSE '[]'::jsonb END) FROM public.repo
      ) source_values WHERE length(trim(value))>0 GROUP BY lower(trim(value))
      ON CONFLICT (slug) DO NOTHING
    `;
    await tx`
      INSERT INTO app.user_topics (user_id,topic_id,strength)
      SELECT source_values.user_id,topic.topic_id,max(source_values.strength) FROM (
        SELECT user_id,jsonb_array_elements_text(CASE WHEN jsonb_typeof(interests)='array' THEN interests ELSE '[]'::jsonb END) AS value,1.0 AS strength FROM public.users
        UNION ALL SELECT user_id,jsonb_array_elements_text(CASE WHEN jsonb_typeof(skills)='array' THEN skills ELSE '[]'::jsonb END),0.8 FROM public.users
        UNION ALL SELECT user_id,jsonb_array_elements_text(CASE WHEN jsonb_typeof(tech_stack)='array' THEN tech_stack ELSE '[]'::jsonb END),0.7 FROM public.users
      ) source_values JOIN app.topics topic ON topic.slug=lower(trim(source_values.value))
      WHERE length(trim(source_values.value))>0 GROUP BY source_values.user_id,topic.topic_id
      ON CONFLICT (user_id,topic_id) DO UPDATE SET strength=EXCLUDED.strength
    `;
  });

  const repoColumns = await client`
    SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='repo'
  `;
  if (!repoColumns.some((row) => row.column_name === 'github_id')) {
    const rows = await client`SELECT repo_id FROM public.repo ORDER BY repo_id`;
    report.rejects.push(...rows.map((row) => `repository:${row.repo_id}:missing_github_numeric_id`));
  } else {
    await client.unsafe(`
      INSERT INTO app.repos (repo_id,github_id,full_name,owner,name,url,status,created_at,updated_at)
      SELECT repo_id,github_id,full_name,owner_id,repo_name,github_repo_url,'active',created_at,updated_at FROM public.repo
      WHERE github_id IS NOT NULL
      ON CONFLICT (github_id) DO UPDATE SET full_name=EXCLUDED.full_name,owner=EXCLUDED.owner,name=EXCLUDED.name,url=EXCLUDED.url,updated_at=now()
      WHERE (app.repos.full_name,app.repos.owner,app.repos.name,app.repos.url)
        IS DISTINCT FROM (EXCLUDED.full_name,EXCLUDED.owner,EXCLUDED.name,EXCLUDED.url)
    `);
  }

  await client`
    INSERT INTO app.repo_topics (repo_id,topic_id)
    SELECT legacy.repo_id,topic.topic_id FROM public.repo legacy
    JOIN app.repos repo ON repo.repo_id=legacy.repo_id
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(legacy.topics)='array' THEN legacy.topics ELSE '[]'::jsonb END
    ) topic_value(value)
    JOIN app.topics topic ON topic.slug=lower(trim(topic_value.value))
    WHERE length(trim(topic_value.value))>0 ON CONFLICT DO NOTHING
  `;

  await client.begin(async (tx) => {
    await tx`
      INSERT INTO app.reactions (user_id,repo_id,reaction)
      SELECT activity.user_id,activity.repo_id,CASE WHEN likelihood_count>0 THEN 'like' ELSE 'dislike' END
      FROM public.activity activity JOIN app.repos repo ON repo.repo_id=activity.repo_id WHERE likelihood_count<>0
      ON CONFLICT (user_id,repo_id) DO UPDATE SET reaction=EXCLUDED.reaction,updated_at=now()
      WHERE app.reactions.reaction IS DISTINCT FROM EXCLUDED.reaction
    `;
    await tx`
      INSERT INTO app.saves (user_id,repo_id)
      SELECT activity.user_id,activity.repo_id FROM public.activity activity JOIN app.repos repo ON repo.repo_id=activity.repo_id
      WHERE is_saved ON CONFLICT DO NOTHING
    `;
    await tx`
      INSERT INTO app.follows (follower_id,following_id,created_at)
      SELECT follower_id,following_id,COALESCE(created_at,now()) FROM public.follows ON CONFLICT DO NOTHING
    `;
    await tx`
      INSERT INTO app.repo_content (repo_id,description,readme,primary_language,languages,content_hash,content_version,updated_at)
      SELECT legacy.repo_id,legacy.description,legacy.readme_md,NULL,COALESCE(legacy.language_used,'[]'::jsonb),
        encode(sha256(convert_to(COALESCE(legacy.description,'')||E'\\n--GH-SOCIAL-CONTENT--\\n'||COALESCE(legacy.readme_md,''),'UTF8')),'hex'),1,now()
      FROM public.repo legacy JOIN app.repos repo ON repo.repo_id=legacy.repo_id
      ON CONFLICT (repo_id) DO NOTHING
    `;
    await tx`
      INSERT INTO app.repo_engagement (repo_id,likes_count,saves_count,comments_count,views_count)
      SELECT legacy.repo_id,COALESCE(legacy.likes_count,0),COALESCE(legacy.saves_count,0),
        COALESCE(legacy.comments_count,0),COALESCE(legacy.views_count,0)
      FROM public.repo legacy JOIN app.repos repo ON repo.repo_id=legacy.repo_id
      ON CONFLICT (repo_id) DO NOTHING
    `;
    await tx`
      INSERT INTO app.comments (comment_id,user_id,repo_id,parent_comment_id,body,created_at,updated_at)
      SELECT legacy.comment_id,legacy.user_id,legacy.repo_id,legacy.parent_comment_id,legacy.comment,
        COALESCE(legacy.created_at,now()),COALESCE(legacy.created_at,now())
      FROM public.comment legacy JOIN app.repos repo ON repo.repo_id=legacy.repo_id
      ON CONFLICT (comment_id) DO NOTHING
    `;
    await tx`
      INSERT INTO app.board_collections (collection_id,user_id,name,description,created_at)
      SELECT container_id,user_id,container_name,description,COALESCE(created_at,now())
      FROM public.boards_containers ON CONFLICT (collection_id) DO NOTHING
    `;
    await tx`
      INSERT INTO app.boards (board_id,user_id,collection_id,name,description,visibility,created_at)
      SELECT board.board_id,board.user_id,mapping.container_id,board.board_name,board.description,
        CASE WHEN board.visibility IN ('private','public') THEN board.visibility ELSE 'private' END,COALESCE(board.created_at,now())
      FROM public.boards board
      LEFT JOIN LATERAL (
        SELECT container_id FROM public.container_boards relation WHERE relation.board_id=board.board_id ORDER BY container_id LIMIT 1
      ) mapping ON true
      ON CONFLICT (board_id) DO NOTHING
    `;
    await tx`
      INSERT INTO app.board_repos (board_id,repo_id,added_at)
      SELECT legacy.board_id,legacy.repo_id,COALESCE(legacy.added_at,now())
      FROM public.board_repos legacy JOIN app.repos repo ON repo.repo_id=legacy.repo_id
      ON CONFLICT DO NOTHING
    `;
    await tx`
      INSERT INTO app.repo_card_summaries (
        repo_id,content_version,model_version,prompt_version,format_version,summary,source,active
      )
      SELECT legacy.repo_id,1,'legacy-backfill','legacy-unversioned','legacy-unversioned',
        legacy.readme_summary,'legacy',false
      FROM public.repo legacy JOIN app.repos repo ON repo.repo_id=legacy.repo_id
      WHERE legacy.readme_summary IS NOT NULL AND length(trim(legacy.readme_summary))>0
      ON CONFLICT (repo_id,content_version,prompt_version,model_version,format_version) DO NOTHING
    `;
  });

  const trendingRows = await client`
    SELECT legacy.repo_id,legacy.trending_rank FROM public.trending_repositories legacy
    JOIN app.repos repo ON repo.repo_id=legacy.repo_id ORDER BY legacy.trending_rank,legacy.repo_id
  `;
  if (trendingRows.length > 0) {
    await client.begin(async (tx) => {
      const snapshotId = '00000000-0000-4000-8000-000000000003';
      await tx`
        INSERT INTO app.trending_snapshots (snapshot_id,period,source,computed_at,activated_at,complete,active)
        VALUES (${snapshotId}::uuid,'legacy','legacy-backfill',to_timestamp(0),now(),true,true)
        ON CONFLICT (snapshot_id) DO UPDATE SET complete=true,active=true,activated_at=COALESCE(app.trending_snapshots.activated_at,now())
      `;
      for (let index = 0; index < trendingRows.length; index++) {
        await tx`
          INSERT INTO app.trending_snapshot_items (snapshot_id,position,repo_id)
          VALUES (${snapshotId}::uuid,${index},${trendingRows[index].repo_id}::uuid)
          ON CONFLICT (snapshot_id,position) DO NOTHING
        `;
      }
    });
  }

  await count('app_users', client`SELECT count(*) FROM app.users`);
  await count('app_repos', client`SELECT count(*) FROM app.repos`);
  await count('topics', client`SELECT count(*) FROM app.topics`);
  await count('user_topics', client`SELECT count(*) FROM app.user_topics`);
  await count('repo_topics', client`SELECT count(*) FROM app.repo_topics`);
  await count('reactions', client`SELECT count(*) FROM app.reactions`);
  await count('saves', client`SELECT count(*) FROM app.saves`);
  await count('comments', client`SELECT count(*) FROM app.comments`);
  await count('boards', client`SELECT count(*) FROM app.boards`);
  await count('board_repos', client`SELECT count(*) FROM app.board_repos`);
  await count('follows', client`SELECT count(*) FROM app.follows`);
  await count('trending_items', client`SELECT count(*) FROM app.trending_snapshot_items`);
  await count('summaries', client`SELECT count(*) FROM app.repo_card_summaries`);
  const orphanRows = await client`
    SELECT activity.repo_id FROM public.activity activity LEFT JOIN app.repos repo ON repo.repo_id=activity.repo_id
    WHERE repo.repo_id IS NULL ORDER BY activity.repo_id
  `;
  report.rejects.push(...orphanRows.map((row) => `activity:${row.repo_id}:repository_not_mapped`));
  for (const table of ['users', 'repos', 'topics', 'user_topics', 'repo_topics', 'reactions', 'saves', 'comments', 'boards', 'board_repos', 'follows']) {
    const rows = await client.unsafe(`SELECT * FROM app.${table} ORDER BY 1`);
    report.checksums[table] = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  const output = process.env.BACKFILL_REPORT ?? path.resolve('../database/backfills/latest-report.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ ...report, completed_at: new Date().toISOString() }, null, 2));
  console.log(`Backfill complete: ${output}; ${report.rejects.length} explained rejects.`);
} finally {
  await client.end();
}
