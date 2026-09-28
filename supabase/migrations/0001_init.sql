-- Cabo MVP schema. Only the game server talks to the database (service-role / direct
-- connection string). RLS is enabled with no policies so the anon/authenticated
-- Supabase APIs cannot read hidden game state.

create table guest_sessions (
  id          uuid primary key,
  token_hash  text not null unique,
  nickname    text not null check (char_length(nickname) between 1 and 20),
  created_at  timestamptz not null default now()
);

create table rooms (
  id               uuid primary key,
  code             char(6) not null unique,
  host_session_id  uuid not null references guest_sessions(id),
  status           text not null check (status in ('lobby', 'playing', 'finished', 'closed')),
  round_no         int not null default 0,
  dealer_index     int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index rooms_status_idx on rooms (status);

create table room_players (
  room_id      uuid not null references rooms(id) on delete cascade,
  session_id   uuid not null references guest_sessions(id),
  seat         int not null,
  total_score  int not null default 0,
  primary key (room_id, session_id)
);

create table games (
  id              uuid primary key,
  room_id         uuid not null references rooms(id) on delete cascade,
  round_no        int not null,
  state_snapshot  jsonb not null,
  version         int not null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  unique (room_id, round_no)
);

alter table guest_sessions enable row level security;
alter table rooms          enable row level security;
alter table room_players   enable row level security;
alter table games          enable row level security;
