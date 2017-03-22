module State exposing (init, update, calculatePriority, calculatePriorityWithWeights, defaultPriorityWeights, normalizeBechdel, normalizeRunTime)

import Dict
import Api
import Types exposing (..)
import Utils
import Navigation
import UrlParser exposing ((<?>))
import Date
import Set


init : Flags -> Navigation.Location -> ( Model, Cmd Msg )
init flags location =
    let
        imdbUserIdsFromPath =
            parseImdbUserIdsFromPath location

        initialModel =
            emptyModel flags

        initalLists =
            Dict.fromList (List.map (Utils.lift2 identity (always [])) imdbUserIdsFromPath)
    in
        { initialModel | lists = initalLists } ! List.map (Api.getWatchlistData initialModel.apiHost) imdbUserIdsFromPath


parseImdbUserIdsFromPath : Navigation.Location -> List String
parseImdbUserIdsFromPath location =
    UrlParser.parsePath (UrlParser.s "" <?> UrlParser.stringParam "imdbUserIds") location
        |> Maybe.andThen identity
        |> Maybe.map (String.split ",")
        |> Maybe.withDefault []


updatedUrl : Model -> String
updatedUrl model =
    "?imdbUserIds=" ++ (String.join "," (Dict.keys model.lists))


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        Void ->
            model ! []

        ImdbUserIdInput partialImdbUserId ->
            { model | imdbUserIdInputCurrentValue = partialImdbUserId } ! []

        LookupWatchList imdbUserId ->
            let
                newModel =
                    { model
                        | imdbUserIdInputCurrentValue = ""
                        , lists = Dict.insert imdbUserId [] model.lists
                    }
            in
                newModel
                    ! [ Api.getWatchlistData model.apiHost imdbUserId, Navigation.modifyUrl (updatedUrl newModel) ]

        ClearList imdbUserId ->
            let
                newModel =
                    { model | lists = Dict.remove imdbUserId model.lists }
            in
                newModel ! [ Navigation.modifyUrl (updatedUrl newModel) ]

        ReceivedWatchList imdbUserId watchListMovies ->
            let
                listOfIds =
                    List.map .id watchListMovies

                newMovies =
                    List.map (Utils.lift2 .id watchListMovieToMovie) watchListMovies
                        |> Dict.fromList

                -- bechdelCommands =
                --     List.map (Api.getBechdelData model.apiHost) listOfIds
                --
                -- justWatchCommands =
                --     List.map (\movie -> Api.getJustWatchData model.apiHost movie.id movie.title movie.itemType (Maybe.map Date.year movie.releaseDate)) watchListMovies
                newGenres =
                    List.foldl Set.union Set.empty (List.map .genres (Dict.values newMovies))
            in
                { model
                    | lists = Dict.insert imdbUserId listOfIds model.lists
                    , movies = Dict.union newMovies model.movies
                    , genres = Set.union newGenres model.genres
                }
                    ! []

        LoadBechdel imdbId (Err error) ->
            model ! []

        LoadBechdel imdbId (Ok bechdelRating) ->
            case Dict.get imdbId model.movies of
                Just movie ->
                    let
                        updatedMovie =
                            { movie | bechdelRating = bechdelRating }
                    in
                        { model | movies = Dict.insert imdbId updatedMovie model.movies } ! []

                Nothing ->
                    model ! []

        LoadJustWatch imdbId (Err error) ->
            model ! []

        LoadJustWatch imdbId (Ok justWatchData) ->
            case ( Dict.get imdbId model.movies, justWatchData ) of
                ( Just movie, Just justWatchData ) ->
                    let
                        updatedMovie =
                            { movie
                                | rottenTomatoesMeter = Maybe.map round (extractScore "tomato:meter" justWatchData.scores)
                                , netflix = extractBestOffer Netflix justWatchData.offers
                                , hbo = extractBestOffer HBO justWatchData.offers
                                , amazon = extractBestOffer Amazon justWatchData.offers
                                , itunes = extractBestOffer ITunes justWatchData.offers
                            }

                        newMovies =
                            Dict.insert imdbId updatedMovie model.movies
                    in
                        { model | movies = newMovies }
                            ! [ Api.getConfirmNetflixData model.apiHost imdbId updatedMovie.title (Maybe.map Date.year updatedMovie.releaseDate) (Maybe.map urlFromOffer updatedMovie.netflix) ]

                _ ->
                    model ! []

        LoadConfirmNetflix imdbId (Err error) ->
            model ! []

        LoadConfirmNetflix imdbId (Ok maybeNetflixUrl) ->
            case Dict.get imdbId model.movies of
                Just movie ->
                    let
                        updatedMovie =
                            { movie
                                | netflix =
                                    case ( maybeNetflixUrl, movie.netflix ) of
                                        ( Just netflixUrl, Just netflixOffer ) ->
                                            Maybe.Just (updateUrl netflixUrl netflixOffer)

                                        ( Just netflixUrl, Nothing ) ->
                                            Maybe.Just (Flatrate Netflix netflixUrl HD)

                                        ( _, _ ) ->
                                            Maybe.Nothing
                            }
                    in
                        { model | movies = Dict.insert imdbId updatedMovie model.movies } ! []

                Nothing ->
                    model ! []

        SetTableState newState ->
            { model | tableState = newState } ! []

        UrlChange newLocation ->
            model ! []

        ToggleGenreFilter genre ->
            (if Set.member genre model.selectedGenres then
                { model | selectedGenres = Set.remove genre model.selectedGenres }
             else
                { model | selectedGenres = Set.insert genre model.selectedGenres }
            )
                ! []


extractBestOffer : JustWatchProvider -> List JustWatchOffer -> Maybe JustWatchOffer
extractBestOffer provider offers =
    List.filter (\offer -> (providerFromOffer offer) == provider) offers
        |> List.sortWith offerOrder
        |> List.head


offerOrder : JustWatchOffer -> JustWatchOffer -> Order
offerOrder offerA offerB =
    compare (offerOrdinal offerA) (offerOrdinal offerB)


offerOrdinal : JustWatchOffer -> ( Int, Int, Float )
offerOrdinal offer =
    let
        presentationTypeOrdinal presentationType =
            case presentationType of
                SD ->
                    1

                HD ->
                    0
    in
        case offer of
            Flatrate _ _ presentationType ->
                ( 0, presentationTypeOrdinal presentationType, 0 )

            Rent _ _ presentationType price ->
                ( 1, presentationTypeOrdinal presentationType, price )

            Buy _ _ presentationType price ->
                ( 2, presentationTypeOrdinal presentationType, price )


extractScore : String -> List JustWatchScore -> Maybe Float
extractScore provider scores =
    List.filter (\score -> score.providerType == provider) scores
        |> List.head
        |> Maybe.map .value


calculateStreamabilityWeight : Movie -> Float
calculateStreamabilityWeight movie =
    if List.any Utils.maybeHasValue [ movie.netflix, movie.hbo ] then
        1
    else if List.any Utils.maybeHasValue [ movie.itunes, movie.amazon ] then
        0.7
    else
        0.1


normalizeBechdel : BechdelRating -> Int
normalizeBechdel bechdel =
    let
        toInt : Bool -> Int
        toInt bool =
            case bool of
                True ->
                    1

                False ->
                    0

        ratingAdjustedForDubious =
            max 0 (toFloat bechdel.rating - 0.5 * (toFloat << toInt) bechdel.dubious)
    in
        round (ratingAdjustedForDubious / 3.0 * 100)


normalizeRunTime : Float -> Float
normalizeRunTime =
    normalizeRunTimeWithParameters 120 0.5


normalizeRunTimeWithParameters : Float -> Float -> Float -> Float
normalizeRunTimeWithParameters optimalRunTime optimalRunTimeScore runTime =
    let
        k =
            (optimalRunTime ^ 2 * optimalRunTimeScore) / (1 - optimalRunTimeScore)
    in
        k / (runTime ^ 2 + k) * 100


calculatePriority : Movie -> Float
calculatePriority =
    calculatePriorityWithWeights defaultPriorityWeights


calculatePriorityWithWeights : PriorityWeights -> Movie -> Float
calculatePriorityWithWeights weights movie =
    let
        extractValueToFloat default maybeInt =
            Maybe.withDefault default (Maybe.map toFloat maybeInt)

        streamabilityWeight =
            calculateStreamabilityWeight movie

        normalizedRunTime =
            normalizeRunTime (extractValueToFloat 90 movie.runTime)

        normalizedBechdel =
            extractValueToFloat 50 (Maybe.map normalizeBechdel movie.bechdelRating)
    in
        streamabilityWeight
            * (weights.metascore
                * (extractValueToFloat 50 movie.metascore)
                + weights.tomatoMeter
                * (extractValueToFloat 50 movie.rottenTomatoesMeter)
                + weights.imdbRating
                * (extractValueToFloat 50 movie.imdbRating)
                + weights.bechdel
                * normalizedBechdel
                + weights.runTime
                * normalizedRunTime
              )


defaultPriorityWeights : PriorityWeights
defaultPriorityWeights =
    let
        runTimeWeight =
            3 / 9

        ratingWeight =
            4 / 9

        bechdelWeight =
            2 / 9
    in
        { runTime = runTimeWeight
        , metascore = ratingWeight / 3
        , tomatoMeter = ratingWeight / 3
        , imdbRating = ratingWeight / 3
        , bechdel = bechdelWeight
        }
