import type { TransactionSql } from 'postgres';

/** Call within the profile writer's transaction, after locking the user row. */
export async function replaceUserTopics(
  tx: TransactionSql,
  userId: string,
  topicSlugs: readonly string[],
  { overwriteDisplayNames }: { overwriteDisplayNames: boolean },
): Promise<void> {
  const slugs = [...new Set(topicSlugs)].sort();
  await tx`DELETE FROM app.user_topics WHERE user_id=${userId}::uuid`;
  if (slugs.length === 0) return;

  // Acquire shared topic-row locks in a consistent order across profile writers.
  // RETURNING includes conflicting rows, avoiding a concurrent-insert visibility
  // gap between a DO NOTHING upsert and a same-statement lookup.
  const topics = await tx`
    INSERT INTO app.topics(slug,display_name)
    SELECT slug,slug FROM unnest(${slugs}::text[]) AS incoming(slug) ORDER BY slug
    ON CONFLICT(slug) DO UPDATE SET display_name=CASE WHEN ${overwriteDisplayNames}
      THEN EXCLUDED.display_name ELSE app.topics.display_name END
    RETURNING topic_id
  `;
  await tx`
    INSERT INTO app.user_topics(user_id,topic_id)
    SELECT ${userId}::uuid,topic_id
    FROM unnest(${topics.map(topic => String(topic.topic_id))}::bigint[]) AS incoming(topic_id)
    ORDER BY topic_id
    ON CONFLICT(user_id,topic_id) DO NOTHING
  `;
}
