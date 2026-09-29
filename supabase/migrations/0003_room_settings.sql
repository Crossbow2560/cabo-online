-- Lobby ⚙ game settings (points limit and timers), kept with the room so they survive restarts.
-- Shape: { "maxPoints": number | null, "peekMs": n, "turnMs": n, "choiceMs": n, "snapMs": n }.
-- Nullable: rooms without settings (older rows) use the defaults. RLS stays on with no policies.
alter table rooms add column settings jsonb;
