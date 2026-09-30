/**
 * Server-side access to the employee list living in the Google Sheet
 * (served by the Apps Script Web App).
 *
 * The Apps Script call is slow (cold start + sheet read), so the list is kept
 * in a process-wide cache: a warm cache answers instantly, and an expired
 * cache is served immediately while it refreshes in the background
 * (stale-while-revalidate). That keeps the employee codes on screen with no
 * "Loading..." wait for every visitor after the first request.
 */

export type Employee = { empCode: string; empName: string; email: string };

/** How long a cached list is considered fresh. */
const TTL_MS = 5 * 60 * 1000;
/** Give up on the Apps Script request instead of hanging the page. */
const TIMEOUT_MS = 15 * 1000;

type UsersCache = { users: Employee[]; at: number; inflight: Promise<Employee[]> | null };

// Survives hot reloads in development by living on globalThis.
const store = globalThis as unknown as { __attendanceUsersCache?: UsersCache };
const cache: UsersCache = (store.__attendanceUsersCache ??= { users: [], at: 0, inflight: null });

function scriptUrl(): string {
  return process.env.GOOGLE_SCRIPT_URL ?? "";
}

export type UsersResult = { users: Employee[]; stale: boolean; error?: string };

/** Reads `?action=users` from the Apps Script Web App. */
async function fetchUsers(url: string): Promise<Employee[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?action=users`, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data?.success || !Array.isArray(data.users)) {
      throw new Error(data?.message || "Apps Script returned an unexpected response");
    }
    return (data.users as Employee[])
      .filter((u) => u && String(u.empCode ?? "").trim() !== "")
      .map((u) => ({
        empCode: String(u.empCode).trim(),
        empName: String(u.empName ?? "").trim(),
        email: String(u.email ?? "").trim(),
      }));
  } finally {
    clearTimeout(timer);
  }
}

/** Single in-flight refresh so parallel requests do not stampede the script. */
function refresh(url: string): Promise<Employee[]> {
  if (!cache.inflight) {
    cache.inflight = fetchUsers(url)
      .then((users) => {
        cache.users = users;
        cache.at = Date.now();
        return users;
      })
      .finally(() => {
        cache.inflight = null;
      });
  }
  return cache.inflight;
}

/**
 * Employee list for the UI. Never throws: on failure it returns the last known
 * list (or an empty one) together with a message the page can display.
 */
export async function loadUsers(): Promise<UsersResult> {
  const url = scriptUrl();
  if (!url) {
    return { users: [], stale: false, error: "GOOGLE_SCRIPT_URL is not configured in .env.local" };
  }

  if (cache.users.length > 0) {
    const isFresh = Date.now() - cache.at < TTL_MS;
    if (!isFresh) void refresh(url).catch(() => undefined); // refresh in the background
    return { users: cache.users, stale: !isFresh };
  }

  try {
    return { users: await refresh(url), stale: false };
  } catch (e) {
    return { users: [], stale: false, error: e instanceof Error ? e.message : "Could not reach Apps Script" };
  }
}
