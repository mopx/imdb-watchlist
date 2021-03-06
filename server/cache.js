import bluebird from 'bluebird';
import redis from 'redis';
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

export const createCache = ({ url, writeOnly }) => {
  const cache = redis.createClient({ url });

  const getJsonFromCache = (key) => {
    if (writeOnly) {
      return Promise.resolve(null);
    }
    return cache.getAsync(key).then((result) => {
      if (result) {
        return JSON.parse(result);
      }
      return null;
    });
  };

  const saveJsonToCache = (key, value, expiryInSeconds) => cache.setexAsync(key, expiryInSeconds, JSON.stringify(value));

  const cachePromise = (key, promiseBuilder, expiryInSeconds) => getJsonFromCache(key).then((cachedValue) => {
    if (cachedValue) {
      console.log(`${key}: Serving from cache`);
      return cachedValue;
    }

    console.log(`${key}: resolving...`);
    return promiseBuilder().then((value) => {
      if (value) {
        return saveJsonToCache(key, value, expiryInSeconds).then(() => value);
      }
      return value;
    });
  });

  return cachePromise;
};
