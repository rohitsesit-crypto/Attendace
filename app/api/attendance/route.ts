import { NextRequest, NextResponse } from "next/server";
import { loadUsers } from "@/app/lib/user";

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

export async function POST(req: NextRequest) {
  if (!SCRIPT_URL) return missingUrl();
  try {
    const body = await req.json();
    const res = await fetch(SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "attendance", ...body }),
      redirect: "follow",
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ success: false, message: "Could not submit attendance" }, { status: 502 });
  }
}
