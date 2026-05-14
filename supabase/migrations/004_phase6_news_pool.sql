-- Phase 6a: 뉴스 수집 풀 테이블
create table if not exists a_news_pool (
  id              bigserial    primary key,
  title           text         not null,
  description     text,
  source_name     text         not null,
  source_type     text         not null default 'newsapi',
  url             text         not null,
  published_at    timestamptz,
  categories      text[]       default '{}',
  keywords        text[]       default '{}',
  language        text         default 'en',
  collected_at    timestamptz  not null default now(),
  used_in_briefing boolean    not null default false,
  constraint a_news_pool_url_unique unique (url)
);

create index if not exists idx_news_pool_collected on a_news_pool (collected_at desc);
create index if not exists idx_news_pool_unused on a_news_pool (used_in_briefing, collected_at desc)
  where NOT used_in_briefing;

-- RLS
alter table a_news_pool enable row level security;
create policy "Service role full access on news_pool"
  on a_news_pool for all using (true) with check (true);
