create table users (
  email         text primary key,
  display_name  text,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- One row per value. A user with several artists has several rows. '__ALL__' lifts a scope.
create table user_attributes (
  email     text not null references users on delete cascade,
  attribute text not null,
  value     text not null,
  primary key (email, attribute, value)
);

create table sessions (
  id         text primary key,
  email      text not null references users on delete cascade,
  expires_at timestamptz not null
);
