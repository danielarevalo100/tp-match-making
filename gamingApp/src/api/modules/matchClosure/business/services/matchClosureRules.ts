import {
  ratingDeltaByResult,
  type DeclaredPlayerResult,
  type FinishMatchInput,
  type MatchClosureRecord,
  type PlayerFinalScore,
  type ScoringEvent,
} from "../models/matchClosure.js";
import {
  MatchClosureConflictError,
  MatchClosureParticipantsError,
} from "../models/matchClosureErrors.js";

/**
 * Una partida en curso se puede cerrar. Una que ya empezó a cerrarse solo acepta el mismo cierre
 * repetido (mismos `closureId`, `eventId` y resultados): así un reintento continúa el cierre en
 * lugar de crear otro distinto.
 */
export function assertSameClosureOrClosable(
  match: MatchClosureRecord,
  input: FinishMatchInput,
): void {
  if (match.status === "voided") throw new MatchClosureConflictError(match.id, match.status);
  if (match.status === "in_progress") return;

  const normalize = (results: readonly DeclaredPlayerResult[]): string =>
    JSON.stringify([...results].sort((left, right) => left.playerId.localeCompare(right.playerId)));
  const sameClosure =
    match.closureId === input.closureId &&
    match.eventId === input.eventId &&
    normalize(match.results ?? []) === normalize(input.results);
  if (!sameClosure) throw new MatchClosureConflictError(match.id, match.status);
}

/**
 * Cada participante tiene exactamente un resultado, y los resultados son todos empates o un grupo
 * de ganadores y otro de perdedores.
 */
export function assertCompleteResults(
  match: MatchClosureRecord,
  results: readonly DeclaredPlayerResult[],
): void {
  const participants = new Set(match.players.map((player) => player.playerId));
  const declared = new Set(results.map((result) => result.playerId));
  if (declared.size !== results.length) {
    throw new MatchClosureParticipantsError("a player appears more than once");
  }
  if (declared.size !== participants.size) {
    throw new MatchClosureParticipantsError("every participant must have one result");
  }
  for (const playerId of declared) {
    if (!participants.has(playerId)) {
      throw new MatchClosureParticipantsError(`player ${playerId} is not in the match`);
    }
  }

  const kinds = new Set(results.map((result) => result.result));
  const allDraws = kinds.size === 1 && kinds.has("draw");
  const winnersAndLosers = kinds.size === 2 && kinds.has("win") && kinds.has("loss");
  if (!allDraws && !winnersAndLosers) {
    throw new MatchClosureParticipantsError(
      "results must be either all draws or a partition of winners and losers",
    );
  }
}

/**
 * Marcador final de la partida: suma los eventos del log (P3) por jugador y aplica el cambio de
 * rating según el resultado declarado.
 */
export function computeFinalScores(
  match: MatchClosureRecord,
  events: readonly ScoringEvent[],
): PlayerFinalScore[] {
  const counters = new Map(
    match.players.map((player) => [
      player.playerId,
      { deaths: 0, kills: 0, objectives: 0, score: 0 },
    ]),
  );
  for (const event of events) {
    const actor = counters.get(event.playerId);
    if (!actor) continue;
    if (event.type === "kill") {
      actor.kills += 1;
      actor.score += event.points;
      const target = event.targetPlayerId ? counters.get(event.targetPlayerId) : undefined;
      if (target) target.deaths += 1;
    } else if (event.type === "objective") {
      actor.objectives += 1;
      actor.score += event.points;
    }
  }

  if (!match.results) throw new MatchClosureParticipantsError("closure results are missing");
  const results = new Map(match.results.map((result) => [result.playerId, result.result]));
  return match.players.map((player) => {
    const counter = counters.get(player.playerId);
    const result = results.get(player.playerId);
    if (!counter || !result) throw new MatchClosureParticipantsError("a player result is missing");
    const ratingDelta = ratingDeltaByResult[result];
    return {
      ...counter,
      mmrAfter: player.mmr + ratingDelta,
      mmrBefore: player.mmr,
      playerId: player.playerId,
      ratingDelta,
      result,
    };
  });
}
