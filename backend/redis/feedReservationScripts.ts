import { TRACK_FEED_VERSION_FUNCTION_LUA } from './feedMaintenanceScripts.js';

// KEYS[4] is the per-user/version active-reservation index. Keep its lease
// aligned with each reservation; generation never deletes reservation data.
const INDEX_RESERVATION_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}
local function trackReservation(ttl)
  if ttl <= 0 then return end
  trackVersion(KEYS[5], ARGV[#ARGV])
  local time = redis.call('time')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  redis.call('zadd', KEYS[4], now + ttl, KEYS[2])
  redis.call('pexpire', KEYS[4], math.max(ttl, redis.call('pttl', KEYS[4])))
end
`;

export const RESERVE_FEED_LUA = `${INDEX_RESERVATION_LUA}
local owner = redis.call('hget', KEYS[2], 'token')
if owner then
  if owner ~= ARGV[1] then return {err='RESERVATION_OWNED'} end
  trackReservation(redis.call('pttl', KEYS[2]))
  return {redis.call('llen', KEYS[1]), redis.call('lrange', KEYS[3], 0, -1)}
end
redis.call('hset', KEYS[2], 'token', ARGV[1], 'request_id', ARGV[2])
redis.call('pexpire', KEYS[2], ARGV[4])
redis.call('del', KEYS[3])
local items = {}
for i = 1, tonumber(ARGV[3]) do
  local item = redis.call('lpop', KEYS[1])
  if not item then break end
  redis.call('rpush', KEYS[3], item)
  table.insert(items, item)
end
redis.call('pexpire', KEYS[3], ARGV[4])
trackReservation(tonumber(ARGV[4]))
return {redis.call('llen', KEYS[1]), items}
`;

export const COMMIT_FEED_LUA = `
if redis.call('hget', KEYS[1], 'token') ~= ARGV[1] then return 0 end
redis.call('zrem', KEYS[3], KEYS[1])
redis.call('del', KEYS[1], KEYS[2])
return 1
`;

export const REFILL_FEED_LUA = `${INDEX_RESERVATION_LUA}
if redis.call('hget', KEYS[2], 'token') ~= ARGV[1] then return {err='RESERVATION_OWNED'} end
local discarded = cjson.decode(ARGV[4])
if #discarded > 100 then return {err='DISCARD_CAPACITY'} end
if #discarded > 0 then
  local held = redis.call('lrange', KEYS[3], 0, 100)
  if #held > 100 then return {err='DISCARD_CAPACITY'} end
  local seen = {}
  for _, id in ipairs(discarded) do seen[id] = true end
  -- Keep the owner/meta/index intact; no same-request retry can claim a gap
  -- between retiring delivered items and reserving the next batch.
  redis.call('del', KEYS[3])
  for _, item in ipairs(held) do
    if not seen[cjson.decode(item).repo_id] then redis.call('rpush', KEYS[3], item) end
  end
end
for i = 1, tonumber(ARGV[2]) do
  local item = redis.call('lpop', KEYS[1])
  if not item then break end
  redis.call('rpush', KEYS[3], item)
end
redis.call('pexpire', KEYS[2], ARGV[3])
redis.call('pexpire', KEYS[3], ARGV[3])
trackReservation(tonumber(ARGV[3]))
return {redis.call('llen', KEYS[1]), redis.call('lrange', KEYS[3], 0, -1)}
`;

export const RELEASE_FEED_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}
if redis.call('hget', KEYS[2], 'token') ~= ARGV[1] then return 0 end
trackVersion(KEYS[5], ARGV[2])
while redis.call('llen', KEYS[3]) > 0 do
  redis.call('lpush', KEYS[1], redis.call('rpop', KEYS[3]))
end
redis.call('del', KEYS[2], KEYS[3])
redis.call('zrem', KEYS[4], KEYS[2])
return 1
`;

// These fixed bounds limit Lua work as well as the exclusion snapshot. Overflow
// fails closed. All writers must use the index before indexed refill is enabled.
const READ_GENERATION_STATE_LUA = `
local function readState()
  if redis.call('get', KEYS[2]) ~= ARGV[1] then return nil end
  local time = redis.call('time')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local expired = redis.call('zrangebyscore', KEYS[3], '-inf', now, 'LIMIT', 0, 128)
  if #expired > 0 then redis.call('zrem', KEYS[3], unpack(expired)) end
  if redis.call('zcard', KEYS[3]) > 128 then return nil end
  local depth = redis.call('llen', KEYS[1])
  local occupancy = depth
  if occupancy > 500 then return nil end
  local seen = {}
  local ids = {}
  local function remember(items)
    for _, item in ipairs(items) do
      local id = cjson.decode(item).repo_id
      if not seen[id] then seen[id] = true; table.insert(ids, id) end
    end
  end
  remember(redis.call('lrange', KEYS[1], 0, -1))
  for _, meta in ipairs(redis.call('zrange', KEYS[3], 0, -1)) do
    if redis.call('pttl', meta) <= 0 then
      redis.call('zrem', KEYS[3], meta)
    else
      local items = string.gsub(meta, ':meta$', ':items')
      occupancy = occupancy + redis.call('llen', items)
      if occupancy > 500 then return nil end
      remember(redis.call('lrange', items, 0, -1))
    end
  end
  return {depth = depth, occupancy = occupancy, ids = ids, seen = seen}
end
`;

export const FEED_GENERATION_STATE_LUA = `${READ_GENERATION_STATE_LUA}
local state = readState()
if not state then return {-1, {}} end
return {state.depth, state.ids, state.occupancy}
`;

export const APPEND_FEED_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}${READ_GENERATION_STATE_LUA}
local state = readState()
if not state then return {'fenced', 0} end
if ARGV[4] == '1' and redis.call('exists', KEYS[4]) == 1 then return {'satisfied', 0} end
local capacity = math.max(0, math.min(tonumber(ARGV[3]) - state.depth, 500 - state.occupancy))
local added = 0
for i = 6, #ARGV do
  if added >= capacity then break end
  local id = cjson.decode(ARGV[i]).repo_id
  if not state.seen[id] then
    redis.call('rpush', KEYS[1], ARGV[i])
    state.seen[id] = true
    added = added + 1
  end
end
-- New candidates rejected by a full queue or current deduplication are not an
-- empty recommendation source. Preserve retryability if a rival drains them.
if #ARGV >= 6 and added == 0 then return {'capacity', 0} end
if added > 0 then
  redis.call('expire', KEYS[1], ARGV[2])
  trackVersion(KEYS[5], ARGV[5])
end
-- Accepting an actual empty source is still a publication. Keep its witness
-- independent of queue consumption, as in the protected replacement path.
redis.call('set', KEYS[4], '1', 'EX', 691200)
return {'published', added}
`;

export const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0
`;

export const RENEW_GENERATION_LOCK_LUA = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('pexpire', KEYS[1], ARGV[2])
`;

// Lease ownership and queue replacement are one Redis operation; a late builder
// cannot overwrite the queue published by a newer lock owner.
export const PUBLISH_GENERATION_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[3] == '1' and redis.call('exists', KEYS[3]) == 1 then return 0 end
redis.call('del', KEYS[2])
for i = 5, #ARGV do redis.call('rpush', KEYS[2], ARGV[i]) end
redis.call('expire', KEYS[2], ARGV[2])
trackVersion(KEYS[4], ARGV[4])
-- Eight days exceeds the hard seven-day prewarm retry horizon. This key is
-- independent of the list: consuming/expiring an empty feed does not erase it.
redis.call('set', KEYS[3], '1', 'EX', 691200)
return 1
`;
