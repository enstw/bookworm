// The pull-mode panel, reader side (PM-08). /admin shows what the updater
// found and lets the owner set the policy — and it reads all of it out of the
// shared D1, never contacting upstream itself. The reader Worker holds no
// relationship with upstream (that lives only in the updater, the one place
// with the trust anchor); the moment /admin fetched upstream, the largest
// attack surface would reacquire it. So these are D1 reads and writes only.
//
// Pure over env.DB, so scripts/test-updater.mjs exercises them with a stub.

const MODES = new Set(["automatic", "notify", "pinned"]);

// A cron-only Worker fails silently — an expired token, a revoked credential,
// a cron that stopped firing all look identical from outside: a timestamp in
// D1 stops moving (R10). The reader watches that timestamp, because a dead
// updater cannot report its own death. Past this threshold — a few times the
// updater's ~15 min check interval — the panel warns and the owner is pushed.
export const SILENT_THRESHOLD_MS = 60 * 60 * 1000;

// Stale for the panel: it has checked before (a fresh install with no updater
// leaves this 0 and must not nag) and has not checked within the threshold.
export const isStale = (lastCheckAt, now) => lastCheckAt > 0 && now - lastCheckAt > SILENT_THRESHOLD_MS;

// Should the reader's cron fire the owner alarm this tick? Only when stale AND
// it has not already alarmed for THIS stall (silent_alarm_for holds the
// last_check_at it last alarmed about). When the updater recovers, last_check_at
// moves; a later stall at a new value alarms again, an unmoving one does not.
export function shouldAlarm({ lastCheckAt, silentAlarmFor, now }) {
  return isStale(lastCheckAt, now) && silentAlarmFor !== lastCheckAt;
}

// Should the reader's cron raise the waiting-for-you push this tick (PM-09)?
// The updater writes notify_version when its decide() lands on NOTIFY — a
// release it will not install without the owner (notify mode, or a
// requires-attention downgrade) — and '' on every other decision. The reader
// pushes the owner ONCE per waiting version (notify_sent_for holds the last it
// pushed), so a version waiting across many ticks rings once and the owner's
// own decision, which moves notify_version, is what lets the next one ring.
export function shouldNotifyWaiting({ notifyVersion, notifySentFor }) {
  return !!notifyVersion && notifyVersion !== notifySentFor;
}

// Should the reader's cron raise the install-failed push this tick (PM-09)?
// Fires once per install attempt whose guarded outcome (PM-07) was not 'ok' —
// 'rolled-back' (the previous version was put back) or 'failed' (the install
// could not proceed, the site unharmed). install_alarm_for holds the
// last_install_at already pushed, so a bad install rings once and a fresh
// install (at 0, result '') never does.
export function shouldAnnounceInstall({ result, installAt, installAlarmFor }) {
  return (result === "rolled-back" || result === "failed") && installAt > 0 && installAlarmFor !== installAt;
}

// The panel object: running version (the reader's own BUILD), what the updater
// last saw of upstream, when it last checked, the policy, the updater's own
// version (so a minUpdaterVersion refusal names a number the owner can look
// up), and the last install's outcome — a rolled-back one included.
export async function readPanel(env, build) {
  const [status, policy] = await Promise.all([
    env.DB.prepare("SELECT * FROM updater_status WHERE id = 1").first(),
    env.DB.prepare("SELECT * FROM updater_policy WHERE id = 1").first(),
  ]);
  const s = status ?? {};
  const p = policy ?? {};
  return {
    running: build,
    updaterVersion: s.updater_version ?? 0,
    upstream: { version: s.upstream_version ?? "", releasedAt: s.upstream_released_at ?? "" },
    lastCheck: { at: s.last_check_at ?? 0, ok: (s.last_check_ok ?? 0) === 1, detail: s.detail ?? "" },
    // the updater has gone silent past the threshold (R10); the panel warns
    stale: isStale(s.last_check_at ?? 0, Date.now()),
    // the owner's decision is pending on this version — notify mode, or a
    // requires-attention downgrade of automatic (PM-09). The reader pushes it
    // and the panel shows it, so an instance with no owner device flagged
    // still says why nothing installed.
    waiting: { version: s.notify_version ?? "", attention: (s.notify_attention ?? 0) === 1 },
    lastInstall: {
      at: s.last_install_at ?? 0, version: s.last_install_version ?? "",
      result: s.last_install_result ?? "", detail: s.last_install_detail ?? "",
    },
    policy: { mode: p.mode || "automatic", soakDays: p.soak_days ?? 2 },
    installNow: { version: p.install_now_version ?? "", at: p.install_now_at ?? 0 },
  };
}

// Set the policy from /admin. The row is seeded by schema.sql, so this only
// ever updates; the mode is one of three and the soak a bounded day count.
export async function setPolicy(env, body) {
  const mode = String(body?.mode ?? "");
  if (!MODES.has(mode)) return { ok: false, error: "mode must be automatic, notify or pinned" };
  const soakDays = Number(body?.soakDays);
  if (!Number.isFinite(soakDays) || soakDays < 0 || soakDays > 365)
    return { ok: false, error: "soakDays must be 0–365" };
  await env.DB.prepare(
    `INSERT INTO updater_policy (id, mode, soak_days) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET mode = excluded.mode, soak_days = excluded.soak_days`,
  ).bind(mode, soakDays).run();
  return { ok: true, mode, soakDays };
}

// Queue the "install now" the notify-mode button needs. It writes the version
// the updater last saw into D1 and the updater picks it up on its next check —
// no callable surface is opened on the updater (the plan's "An install button,
// without giving the updater a door"). Refuses when nothing has been seen yet,
// so the button cannot queue an empty request.
export async function queueInstallNow(env, now) {
  const s = await env.DB.prepare("SELECT upstream_version FROM updater_status WHERE id = 1").first();
  const version = s?.upstream_version ?? "";
  if (!version) return { ok: false, error: "no upstream version seen yet" };
  await env.DB.prepare(
    `INSERT INTO updater_policy (id, install_now_version, install_now_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET install_now_version = excluded.install_now_version, install_now_at = excluded.install_now_at`,
  ).bind(version, now).run();
  return { ok: true, version };
}
