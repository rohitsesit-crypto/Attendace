import { NextRequest, NextResponse } from "next/server";
import { loadUsers } from "@/app/lib/user";
import {
  AUTO_OUT_AFTER_HOURS,
  AUTO_OUT_TIME,
  decideAutoClose,
  formatClock,
  parseTimeToMinutes,
} from "@/app/lib/attendance";

// Proxy to Google Apps Script Web App (avoids browser CORS issues).
const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL ?? "";

export const dynamic = "force-dynamic";

function missingUrl() {
  return NextResponse.json(
    { success: false, message: "GOOGLE_SCRIPT_URL is not configured in .env.local" },
    { status: 500 }
  );
}

/** Employee codes for the dropdown, served from the cache whenever possible. */
export async function GET() {
  const { users, stale, error } = await loadUsers();
  if (error && users.length === 0) {
    return NextResponse.json({ success: false, message: error }, { status: 502 });
  }
  return NextResponse.json({ success: true, users, stale, count: users.length });
}

/**
 * Two actions share this endpoint:
 *   { action: "attendance", ... }        -> mark an In/Out entry
 *   { action: "autoClose", dryRun?: true } -> run the forgotten-Out pass
 *
 * The auto-close action is what the 15-minute trigger runs inside Apps Script;
 * `dryRun: true` only evaluates the rule locally and writes nothing, which is
 * how to confirm the "12 hours, then 6:30 PM" behaviour from the app.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action === "autoClose" && body.dryRun === true) {
    const inTime = body.inTime;
    if (inTime === undefined || inTime === null || String(inTime).trim() === "") {
      return NextResponse.json({ success: false, message: "inTime is required for a dry run" }, { status: 400 });
    }

    const now = typeof body.now === "string" ? new Date(body.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      return NextResponse.json({ success: false, message: "now is not a valid date" }, { status: 400 });
    }

    const inDate = typeof body.inDate === "string" ? new Date(`${body.inDate}T00:00:00`) : now;
    if (Number.isNaN(inDate.getTime())) {
      return NextResponse.json({ success: false, message: "inDate is not a valid date" }, { status: 400 });
    }

    const decision = decideAutoClose({ inTime, now, inDate });
    const inMinutes = parseTimeToMinutes(inTime);

    return NextResponse.json({
      success: true,
      dryRun: true,
      rule: { afterHours: AUTO_OUT_AFTER_HOURS, defaultOut: AUTO_OUT_TIME },
      closes: decision.close,
      reason: decision.reason,
      unreadable: decision.unreadable,
      elapsedMinutes: decision.elapsedMinutes,
      outTime: decision.close ? decision.outTime : null,
      outDate: decision.close ? decision.outDate.toISOString().slice(0, 10) : null,
      hours: decision.close ? decision.hours : null,
      // When the 12-hour wait ends, derived from the In time itself.
      twelveHourMark:
        inMinutes === null ? null : formatClock(inMinutes + AUTO_OUT_AFTER_HOURS * 60),
    });
  }

  if (!SCRIPT_URL) return missingUrl();

  try {
    const action = body.action === "autoClose" ? "autoClose" : "attendance";
    const res = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...body, action }),
      redirect: "follow",
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ success: false, message: "Could not submit attendance" }, { status: 502 });
  }
}
