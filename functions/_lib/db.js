// Tiny D1 helpers. `env.DB` binding is configured in the dashboard (or wrangler.toml locally).

export function first(env, sql, ...args) {
  const stmt = env.DB.prepare(sql);
  return args.length ? stmt.bind(...args).first() : stmt.first();
}

export async function all(env, sql, ...args) {
  const stmt = env.DB.prepare(sql);
  const res = args.length ? await stmt.bind(...args).all() : await stmt.all();
  return res.results || [];
}

export async function run(env, sql, ...args) {
  const stmt = env.DB.prepare(sql);
  return args.length ? stmt.bind(...args).run() : stmt.run();
}
