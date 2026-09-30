import AttendanceForm from "./attendance-form";
import { loadUsers } from "./lib/user";

// Rendered per request: the employee list comes from the Google Sheet, so the
// codes are already in the HTML instead of being fetched after hydration.
export const dynamic = "force-dynamic";

export default async function AttendancePage() {
  const { users, stale } = await loadUsers();
  return <AttendanceForm initialEmployees={users} initialStale={stale} />;
}
