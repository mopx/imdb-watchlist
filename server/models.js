export const movieData = (
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
      netflix: netflix || null,
      hbo: hbo || null,
      itunes: itunes || null,
      amazon: amazon || null,
    },
  };
};

export const viewingOptionData = (
  {
    provider,
    url,
    monetizationType,
    presentationType,
    price,
  }
) => {
  return {
    provider,
    url,
    monetizationType,
    presentationType,
    price: price || null,
  };
};
