-- Samvaad database. Paste this whole file into Supabase: SQL Editor -> New query -> Run.
--
-- Row Level Security is switched ON for every table with NO policies, which
-- means nobody can read or write these tables from a browser. Only the Flask
-- server can, using the service role key (SUPABASE_SERVICE_KEY), and it
-- always filters by the signed-in user's id.

create table if not exists public.profiles (
  user_id     text primary key,          -- Supabase auth user id
  name        text,
  email       text,
  phone       text,
  salary      double precision,          -- monthly take-home, rupees
  employer    text,
  city        text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists public.loans (
  id               text primary key,
  user_id          text not null references public.profiles(user_id) on delete cascade,
  type             text not null,        -- personal, home, car, credit_card, ...
  lender           text,
  outstanding      double precision not null,
  rate             double precision not null,   -- % per year
  emi              double precision not null,
  months_left      integer,
  foreclosure_pct  double precision,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists loans_user_idx on public.loans(user_id);

create table if not exists public.requests (
  id          text primary key,
  user_id     text not null references public.profiles(user_id) on delete cascade,
  kind        text not null,             -- balance_transfer, fresh_loan, payoff_help, callback
  details     jsonb default '{}'::jsonb,
  status      text not null default 'new',
  admin_note  text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists requests_user_idx on public.requests(user_id);
create index if not exists requests_status_idx on public.requests(status);

create table if not exists public.banks (
  id                  text primary key,
  name                text not null,
  product             text not null,
  rate_min            double precision not null,
  rate_max            double precision,
  processing_fee_pct  double precision default 0,
  max_tenure_months   integer,
  active              boolean default true,
  notes               text,
  updated_at          timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.loans    enable row level security;
alter table public.requests enable row level security;
alter table public.banks    enable row level security;

-- Placeholder offers so the app works on day one. Replace them in the admin
-- panel with the banks you're empanelled with and their real rate cards.
insert into public.banks (id, name, product, rate_min, rate_max, processing_fee_pct, max_tenure_months, notes)
select * from (values
  ('sample-a-personal', 'Sample Bank A', 'personal',    10.5,  14.0, 1.0,  72, 'Sample rates — replace'),
  ('sample-b-personal', 'Sample Bank B', 'personal',    11.25, 16.0, 1.5,  60, 'Sample rates — replace'),
  ('sample-a-home',     'Sample Bank A', 'home',         8.35,  9.25, 0.5, 360, 'Sample rates — replace'),
  ('sample-c-home',     'Sample NBFC C', 'home',         8.9,  10.5,  0.5, 300, 'Sample rates — replace'),
  ('sample-b-car',      'Sample Bank B', 'car',          8.75, 10.5,  1.0,  84, 'Sample rates — replace'),
  ('sample-c-card',     'Sample NBFC C', 'credit_card', 12.0,  16.0,  2.0,  48, 'Sample rates — replace'),
  ('sample-a-business', 'Sample Bank A', 'business',    13.0,  18.0,  2.0,  60, 'Sample rates — replace')
) as v(id, name, product, rate_min, rate_max, processing_fee_pct, max_tenure_months, notes)
where not exists (select 1 from public.banks);
