import { NextRequest, NextResponse } from "next/server";

// Proxy to Google Apps Script Web App (avoids browser CORS issues).
const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL ?? "";

function missingUrl() {
  return NextResponse.json(
    { success: false, message: "GOOGLE_SCRIPT_URL is not configured in .env.local" },
    { status: 500 }
  );
}

export async function GET() {
  if (!SCRIPT_URL) return missingUrl();
  try {
    const res = await fetch(`${SCRIPT_URL}?action=users`, { cache: "no-store", redirect: "follow" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ success: false, message: "Could not reach Apps Script" }, { status: 502 });
  }
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
