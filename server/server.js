import newrelic from 'newrelic';
import express from 'express';
import fetch from 'node-fetch';
import cheerio from 'cheerio';
import bodyParser from 'body-parser';
import request from 'request';
import cors from 'cors';
import bluebird from 'bluebird';
import redis from 'redis';
import expressWs from 'express-ws';
import http from 'http';
import leven from 'leven';
bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

const app = express();
expressWs(app);

const cache = redis.createClient({ url: process.env.REDIS_URL });

if (process.env.DISABLE_CACHE) {
  console.log('Cache is disabled');
}

app.use(bodyParser.json());
app.use(cors());

app.ws('/stream', (ws, req) => {
  console.log('Connected');
  ws.on('message', messageAsString => {
    const message = JSON.parse(messageAsString);
    switch (message.type) {
      case 'watchlist': {
        const { userId } = message.body;
        fetchWatchList(userId).then(list => {
          ws.send(
            JSON.stringify({ type: message.type, body: { userId, list } })
          );
        });
        break;
      }
      case 'movie': {
        const { movie } = message.body;
        fetchMovieDetails(movie).then(movie => {
          ws.send(JSON.stringify({ type: message.type, body: { movie } }));
        });
        break;
      }
    }
  });
});

const handleErrors = response => {
  if (!response.ok) {
    throw Error(response.statusText);
  }
  return response;
};

const getJsonFromCache = cache =>
  key => {
    if (process.env.DISABLE_CACHE) {
      return Promise.resolve(null);
    }
    return cache.getAsync(key).then(result => {
      if (result) {
        return JSON.parse(result);
      } else {
        return null;
      }
    });
  };
const saveJsonToCache = cache =>
  (key, value, expiryInSeconds) => {
    return cache.setexAsync(key, expiryInSeconds, JSON.stringify(value));
  };

const fetchWatchList = userId => {
  return fetch(`http://www.imdb.com/user/${userId}/watchlist?view=detail`)
    .then(response => response.text())
    .then(text => {
      const initialStateRegex = /IMDbReactInitialState\.push\((\{.+\})\);/g;
      const matches = initialStateRegex.exec(text);
      const initialStateText = matches[1];

      const watchlistData = JSON.parse(initialStateText);

      const movieIds = watchlistData.list.items.map(i => i.const);

      return fetch(`http://www.imdb.com/title/data?ids=${movieIds.join(',')}`, {
        method: 'GET',
        headers: { 'Accept-Language': 'en-US,en' },
      })
        .then(response => response.json())
        .then(movieData => {
          const movies = movieIds.map(movieId =>
            convertImdbMovieToMovie(movieData[movieId].title));

          return {
            id: watchlistData.list.id,
            name: watchlistData.list.name,
            movies,
          };
        });
    });
};

const calculateMovieRunTime = imdbMovieData => {
  const numberOfEpisodes = imdbMovieData.metadata.numberOfEpisodes || 1;
  const runTimeInSeconds = imdbMovieData.metadata.runtime;
  return runTimeInSeconds ? runTimeInSeconds * numberOfEpisodes / 60 : null;
};

const convertImdbMovieToMovie = imdbMovieData => {
  return movieData({
    id: imdbMovieData.id,
    title: imdbMovieData.primary.title,
    imdbUrl: `http://www.imdb.com${imdbMovieData.primary.href}`,
    type: imdbMovieData.type,
    releaseDate: imdbMovieData.metadata.release,
    runTime: calculateMovieRunTime(imdbMovieData),
    genres: imdbMovieData.metadata.genres,
    metascore: imdbMovieData.ratings.metascore,
    imdbRating: imdbMovieData.ratings.rating * 10,
  });
};

const movieData = (
  {
    id,
    title,
    imdbUrl,
    type,
    releaseDate,
    runTime,
    genres,
    metascore,
    rottenTomatoesMeter,
    imdbRating,
    bechdelRating,
    netflix,
    hbo,
    itunes,
    amazon,
  }
) => {
  return {
    id,
    title,
    imdbUrl,
    type,
    releaseDate,
    runTime,
    genres,
    ratings: {
      metascore,
      rottenTomatoesMeter,
      imdb: imdbRating,
      bechdel: bechdelRating,
    },
    viewingOptions: {
      netflix,
      hbo,
      itunes,
      amazon,
    },
  };
};

const fetchWithCache = (url, options, expiryInSeconds) => {
  const cacheKey = `request:${url}`;
  return getJsonFromCache(cache)(cacheKey).then(cachedResponse => {
    if (cachedResponse) {
      console.log(`${url}: Serving from cache`);
      return cachedResponse;
    }

    console.log(`${url}: Fetching...`);
    return fetch(url, options)
      .then(response => response.json())
      .then(json =>
        saveJsonToCache(cache)(cacheKey, json, expiryInSeconds).then(
          () => json
        ));
  });
};

const fetchMovieDetails = movie => {
  return Promise.all([
    fetchBechdel(movie.id).catch(error => null),
  ]).then(bechdelRating_ => {
    const bechdelRating = bechdelRating_[0];
    return movieData({
      ...movie,
      bechdelRating,
    });
  });
};

const fetchBechdel = imdbId => {
  const imdbIdWithoutPrefix = imdbId.replace('tt', '');
  const url = `http://bechdeltest.com/api/v1/getMovieByImdbId?imdbid=${imdbIdWithoutPrefix}`;

  return fetchWithCache(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
    },
    30 * 24 * 60 * 60
  )
    .then(json => {
      if (json.status) {
        return null;
      }
      return json;
    })
    .then(json => {
      return { rating: parseInt(json.rating), dubious: json.dubious === '1' };
    });
};
//
// const justwatchCacheKey = imdbId => {
//   return `justwatch:${imdbId}`;
// };
//
// const findBestPossibleJustwatchResult = (title, year, type, results) => {
//   if (!results) {
//     return null;
//   }
//
//   return results.filter(result => {
//     const titleMatch = leven(result.title.toLowerCase(), title.toLowerCase());
//     const titleAndYearMatch = titleMatch === 0 &&
//       result.original_release_year === year;
//     const fuzzyTitleAndYearMatch = titleMatch <= 5 &&
//       result.original_release_year === year;
//     const titleMatchesForSeries = titleMatch === 0 && type === 'series';
//     return titleAndYearMatch || fuzzyTitleAndYearMatch || titleMatchesForSeries;
//   })[0];
// };
//
// const justwatchType = itemType => {
//   switch (itemType) {
//     case 'film':
//       return 'movie';
//     case 'series':
//       return 'show';
//   }
// };

// const fetchJustWatchData = (imdbId, title, type, year) => {
//   return getJsonFromCache(cache)(
//     justwatchCacheKey(imdbId)
//   ).then(cachedResponse => {
//     if (cachedResponse) {
//       console.log(`/api/justwatch ${imdbId}: Serving from cache`);
//       res.json(cachedResponse);
//       return;
//     }
//
//     fetch('https://api.justwatch.com/titles/en_US/popular', {
//       method: 'POST',
//       body: JSON.stringify({
//         content_types: [justwatchType(type)],
//         query: title,
//       }),
//       headers: {
//         Accept: 'application/json, text/plain, */*',
//         'Content-Type': 'application/json',
//       },
//     })
//       .then(handleErrors)
//       .then(response => {
//         return response.json();
//       })
//       .then(json => {
//         const possibleItem = findBestPossibleJustwatchResult(
//           title,
//           year,
//           type,
//           json.items
//         );
//
//         if (!possibleItem) {
//           res.json({ data: null });
//           return;
//         }
//
//         const item = possibleItem;
//
//         const response = {
//           data: {
//             id: item.id,
//             href: `https://www.justwatch.com${item.full_path}`,
//             offers: item.offers,
//             scoring: item.scoring,
//           },
//         };
//
//         saveJsonToCache(cache)(
//           justwatchCacheKey(imdbId),
//           response,
//           24 * 60 * 60
//         ).then(() => {
//           res.json(response);
//         });
//       });
//   });
// };
//
// app.get('/api/justwatch', (req, res) => {
//   const imdbId = req.query.imdbId;
//   const title = req.query.title;
//   const type = req.query.type;
//   const year = parseInt(req.query.year || '0');
// });
//

// const netflixCacheKey = imdbId => {
//   return `netflix:${imdbId}`;
// };
//
// //
// // We get Netflix urls from JustWatch which work for the U.S. Netflix.
// // Those won't necessary work on the Icelandic Netflix. The movie
// // seems to have the same ID though so we try to see if a localized
// // url returns 200.
// app.get('/api/netflix', (req, res) => {
//   const imdbId = req.query.imdbId;
//   const title = req.query.title;
//   const year = parseInt(req.query.year || '0');
//   const locale = req.query.locale;
//   var netflixUrl = req.query.netflixUrl &&
//     req.query.netflixUrl.replace('http://', 'https://');
//
//   getJsonFromCache(cache)(netflixCacheKey(imdbId)).then(cachedResponse => {
//     if (cachedResponse) {
//       console.log(`/api/netflix ${imdbId}: Serving from cache`);
//       res.json(cachedResponse);
//       return;
//     }
//
//     if (netflixUrl) {
//       checkIfMovieIsAvailableOnNetflix(
//         imdbId,
//         netflixUrl,
//         locale
//       ).then(netflixUrl => {
//         const payload = { data: { netflixUrl: netflixUrl } };
//
//         saveJsonToCache(cache)(
//           netflixCacheKey(imdbId),
//           payload,
//           24 * 60 * 60
//         ).then(() => {
//           res.json(payload);
//         });
//       });
//     } else {
//       fetch(
//         `http://denmark.flixlist.co/autocomplete/titles?q=${encodeURIComponent(title)}`
//       )
//         .then(response => {
//           if (!response.ok) {
//             return {};
//           }
//           return response.json();
//         })
//         .then(json => {
//           const possibleNetflixId = json
//             .filter(result => {
//               return result.title === title; // This missing a check for year but it still much better than nothing.
//             })
//             .map(result => {
//               return result.url.replace('/titles/', '');
//             })[0];
//
//           if (possibleNetflixId) {
//             checkIfMovieIsAvailableOnNetflix(
//               imdbId,
//               `https://www.netflix.com/title/${possibleNetflixId}`,
//               locale
//             ).then(netflixUrl => {
//               const payload = { data: { netflixUrl: netflixUrl } };
//
//               saveJsonToCache(cache)(
//                 netflixCacheKey(imdbId),
//                 payload,
//                 24 * 60 * 60
//               ).then(() => {
//                 res.json(payload);
//               });
//             });
//           } else {
//             res.json({ data: null });
//           }
//         });
//     }
//   });
// });
//
// const checkIfMovieIsAvailableOnNetflix = (imdbId, netflixUrl, locale) => {
//   const netflixUrlInLocale = netflixUrl.replace('/title/', `/${locale}/title/`);
//
//   const requestUrl = netflixUrl;
//   return new Promise(function(resolve, reject) {
//     request(
//       { method: 'GET', followRedirect: false, url: requestUrl },
//       (error, response, body) => {
//         const locationHeader = response.headers['location'];
//         console.log(
//           `/api/netflix ${imdbId}: Netflix returned ${response.statusCode} on ${requestUrl} with location ${locationHeader}`
//         );
//
//         resolve(
//           response.statusCode == 200 || locationHeader === netflixUrlInLocale
//             ? netflixUrlInLocale
//             : null
//         );
//       }
//     );
//   });
// };

// process.env.PORT lets the port be set by Heroku
const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`App listening on port ${port}!`);
});
