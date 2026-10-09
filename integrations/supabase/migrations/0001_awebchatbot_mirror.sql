-- AWebChatbot -> Supabase mirror.
-- The Worker upserts rows here (via PostgREST with the service-role key) whenever SUPABASE_URL and
-- SUPABASE_SERVICE_KEY are set. Use it for SQL analytics, BI tools, Supabase Auth-powered dashboards,
-- or joining chat data with your own app tables.
--
-- Apply with the Supabase CLI:  supabase db push   (or paste into the SQL editor)

create table if not exists public.awc_customers (
  id text primary key,
  workspace_id text not null,
  visitor_id text not null,
  name text,
  email text,
  phone text,
  attributes jsonb not null default '{}'::jsonb,
  first_seen_at bigint not null,
  last_seen_at bigint not null,
  synced_at timestamptz not null default now()
);
create index if not exists awc_customers_ws_email on public.awc_customers (workspace_id, email);

create table if not exists public.awc_conversations (
  id text primary key,
  workspace_id text not null,
  customer_id text not null,
  status text not null,
  mode text not null,
  assignee_id text,
  subject text,
  page_url text,
  meta jsonb not null default '{}'::jsonb,
  message_count integer not null default 0,
  last_message_at bigint not null,
  last_message_preview text,
  handoff_at bigint,
  first_response_at bigint,
  rating integer,
  created_at bigint not null,
  updated_at bigint not null,
  closed_at bigint,
  synced_at timestamptz not null default now()
);
create index if not exists awc_conversations_ws_created on public.awc_conversations (workspace_id, created_at desc);
create index if not exists awc_conversations_customer on public.awc_conversations (customer_id);

create table if not exists public.awc_messages (
  id text primary key,
  conversation_id text not null,
  workspace_id text not null,
  role text not null,
  author_id text,
  content text not null,
  attachments jsonb not null default '[]'::jsonb,
  buttons jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at bigint not null,
  synced_at timestamptz not null default now()
);
create index if not exists awc_messages_conv on public.awc_messages (conversation_id, created_at);
create index if not exists awc_messages_ws_created on public.awc_messages (workspace_id, created_at desc);
create index if not exists awc_messages_fts on public.awc_messages using gin (to_tsvector('english', content));

-- Keep synced_at fresh on upsert.
create or replace function public.awc_touch_synced_at() returns trigger language plpgsql as $$
begin
  new.synced_at := now();
  return new;
end $$;

drop trigger if exists awc_customers_touch on public.awc_customers;
create trigger awc_customers_touch before update on public.awc_customers for each row execute function public.awc_touch_synced_at();
drop trigger if exists awc_conversations_touch on public.awc_conversations;
create trigger awc_conversations_touch before update on public.awc_conversations for each row execute function public.awc_touch_synced_at();
drop trigger if exists awc_messages_touch on public.awc_messages;
create trigger awc_messages_touch before update on public.awc_messages for each row execute function public.awc_touch_synced_at();

-- Lock the tables down: only the service role (used by the Worker) can read/write.
-- Add policies for your own authenticated dashboards as needed.
alter table public.awc_customers enable row level security;
alter table public.awc_conversations enable row level security;
alter table public.awc_messages enable row level security;

-- Analytics helpers -----------------------------------------------------------------------------

create or replace view public.awc_daily_stats as
select
  workspace_id,
  (to_timestamp(created_at / 1000.0) at time zone 'utc')::date as day,
  count(*) as conversations,
  count(*) filter (where handoff_at is not null) as handoffs,
  count(*) filter (where status = 'closed' and handoff_at is null) as bot_resolved,
  round(avg((first_response_at - handoff_at) / 60000.0) filter (where first_response_at is not null and handoff_at is not null), 1) as avg_first_response_min,
  round(avg(rating)::numeric, 2) as csat
from public.awc_conversations
group by 1, 2;

create or replace view public.awc_leads as
select c.workspace_id, c.id as customer_id, c.name, c.email, c.phone, c.attributes,
       to_timestamp(c.first_seen_at / 1000.0) as first_seen, to_timestamp(c.last_seen_at / 1000.0) as last_seen
from public.awc_customers c
where c.email is not null;

-- Full-text search across all chats: select * from public.awc_search_messages('refund policy');
create or replace function public.awc_search_messages(q text, ws text default null)
returns setof public.awc_messages language sql stable as $$
  select * from public.awc_messages
  where to_tsvector('english', content) @@ websearch_to_tsquery('english', q)
    and (ws is null or workspace_id = ws)
  order by created_at desc
  limit 200;
$$;
