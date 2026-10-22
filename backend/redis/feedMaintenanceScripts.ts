// Tracking is expendable: evict only index members, never queue/reservation data.
// Legacy repair rediscovers omitted versions. Keep at most 128 version members
// under normal writers, and never prune an unbounded corrupt/legacy index.
// Indexes are hints, so their 24-hour idle lease may expire independently of
// authoritative queues/reservations. Repair does not extend an existing lease.
export const TRACK_FEED_VERSION_FUNCTION_LUA = `
local function expireVersionIndex(index, refresh)
  if refresh or redis.call('pttl', index) == -1 then
    redis.call('pexpire', index, 86400000)
  end
end
local function trackVersion(index, version)
  expireVersionIndex(index, true)
  if redis.call('zscore', index, version) then return end
  local count = redis.call('zcard', index)
  if count >= 128 then
    local oldest = redis.call('zrange', index, 0, math.min(count - 128, 127))
    if #oldest > 0 then redis.call('zrem', index, unpack(oldest)) end
  end
  if redis.call('zcard', index) >= 128 then return end
  local time = redis.call('time')
  redis.call('zadd', index, tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000), version)
  expireVersionIndex(index, true)
end
`;

// Also give pre-upgrade persistent indexes an expiry when their bounded legacy
// scan slot is visited. PTTL + PEXPIRE run atomically, with no Redis-version flags.
export const EXPIRE_FEED_VERSION_INDEX_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}
expireVersionIndex(KEYS[1], false)
return 1
`;

export const TRACK_FEED_VERSION_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}
trackVersion(KEYS[1], ARGV[1])
return 1
`;

// Atomic metadata snapshot and repair: a concurrent owner/lease change cannot
// pair an old token with a new TTL, or remove newly registered membership.
export const READ_FEED_RESERVATION_LUA = `${TRACK_FEED_VERSION_FUNCTION_LUA}
local token = redis.call('hget', KEYS[1], 'token')
local ttl = redis.call('pttl', KEYS[1])
if not token or ttl <= 0 then
  redis.call('zrem', KEYS[2], KEYS[1])
  return {}
end
local time = redis.call('time')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('zadd', KEYS[2], now + ttl, KEYS[1])
redis.call('pexpire', KEYS[2], math.max(ttl, redis.call('pttl', KEYS[2])))
trackVersion(KEYS[3], ARGV[1])
return {token, ttl}
`;

// Versions are bigint decimals: never convert to Lua doubles for comparison.
// Only exact older queue keys are deleted, not reservations, indexes, locks,
// the captured current version, or versions created after the DB snapshot.
export const DELETE_STALE_FEED_VERSIONS_LUA = `
local keep = ARGV[1]
local prefix = ARGV[2]
local deleted = 0
local time = redis.call('time')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
for _, version in ipairs(redis.call('zrange', KEYS[1], 0, 127)) do
  if not string.match(version, '^%d+$') or (#version > 1 and string.sub(version, 1, 1) == '0') then
    redis.call('zrem', KEYS[1], version)
  elseif #version < #keep or (#version == #keep and version < keep) then
    deleted = deleted + redis.call('del', prefix .. version)
    redis.call('zrem', KEYS[1], version)
  elseif redis.call('exists', prefix .. version) == 0 then
    redis.call('zrem', KEYS[1], version)
  else
    redis.call('zadd', KEYS[1], now, version)
  end
end
return deleted
`;
