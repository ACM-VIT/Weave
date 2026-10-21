export const RESERVE_FEED_LUA = `
local owner = redis.call('hget', KEYS[2], 'token')
if owner then
  if owner ~= ARGV[1] then return {err='RESERVATION_OWNED'} end
  return redis.call('lrange', KEYS[3], 0, -1)
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
return items
`;

export const COMMIT_FEED_LUA = `
if redis.call('hget', KEYS[1], 'token') ~= ARGV[1] then return 0 end
redis.call('del', KEYS[1], KEYS[2])
return 1
`;

export const REFILL_FEED_LUA = `
if redis.call('hget', KEYS[2], 'token') ~= ARGV[1] then return {err='RESERVATION_OWNED'} end
for i = 1, tonumber(ARGV[2]) do
  local item = redis.call('lpop', KEYS[1])
  if not item then break end
  redis.call('rpush', KEYS[3], item)
end
redis.call('pexpire', KEYS[2], ARGV[3])
redis.call('pexpire', KEYS[3], ARGV[3])
return redis.call('lrange', KEYS[3], 0, -1)
`;

export const RELEASE_FEED_LUA = `
if redis.call('hget', KEYS[2], 'token') ~= ARGV[1] then return 0 end
while redis.call('llen', KEYS[3]) > 0 do
  redis.call('lpush', KEYS[1], redis.call('rpop', KEYS[3]))
end
redis.call('del', KEYS[2], KEYS[3])
return 1
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
export const PUBLISH_GENERATION_LUA = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('del', KEYS[2])
for i = 3, #ARGV do redis.call('rpush', KEYS[2], ARGV[i]) end
redis.call('expire', KEYS[2], ARGV[2])
return 1
`;
