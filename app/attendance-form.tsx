"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Employee = { empCode: string; empName: string; email: string };
type Status = { type: "success" | "error" | "info"; text: string } | null;

const LS_KEY = "attendance.users.v1";

/** Previously seen employee codes, used to paint the dropdown instantly. */
function cachedUsers(): Employee[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as Employee[]) : [];
  } catch {
    return [];
  }
}

function sameUsers(a: Employee[], b: Employee[]): boolean {
  return (
    a.length === b.length &&
    a.every((u, i) => u.empCode === b[i].empCode && u.empName === b[i].empName && u.email === b[i].email)
  );
}

export default function AttendanceForm({
  initialEmployees,
  initialStale,
}: {
  initialEmployees: Employee[];
  initialStale: boolean;
}) {
  // Server-rendered codes are available on first paint; the local cache is only
  // a fallback for the rare case where the server could not reach the sheet.
  const [employees, setEmployees] = useState<Employee[]>(() =>
    initialEmployees.length > 0 ? initialEmployees : []
  );
  const [loadingUsers, setLoadingUsers] = useState(initialEmployees.length === 0);
  const [empCode, setEmpCode] = useState("");
  const [entryType, setEntryType] = useState("In");
  const [locationType, setLocationType] = useState("In office");
  const [photo, setPhoto] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const sorted = useMemo(() => {
    const byCode = new Map<string, Employee>();
    employees.forEach((e) => byCode.set(e.empCode, e));
    return [...byCode.values()].sort((a, b) =>
      a.empCode.localeCompare(b.empCode, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [employees]);

  const selected = sorted.find((e) => e.empCode === empCode);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => {
    // Show the last known codes immediately while the server refresh lands.
    if (initialEmployees.length === 0) {
      const local = cachedUsers();
      if (local.length > 0) {
        setEmployees(local);
        setLoadingUsers(false);
      }
    }

    let active = true;
    const sync = async () => {
      try {
        const res = await fetch("/api/attendance", { cache: "no-store" });
        const d = await res.json();
        if (!active) return;
        if (d.success && Array.isArray(d.users) && d.users.length > 0) {
          setEmployees((prev) => (sameUsers(prev, d.users) ? prev : d.users));
          try {
            window.localStorage.setItem(LS_KEY, JSON.stringify(d.users));
          } catch {
            /* storage full or blocked - the list is already in memory */
          }
        } else if (d.message && initialEmployees.length === 0) {
          setStatus({ type: "error", text: d.message });
        }
      } catch {
        if (active && initialEmployees.length === 0) {
          setStatus({ type: "error", text: "Failed to load employees" });
        }
      } finally {
        if (active) setLoadingUsers(false);
      }
    };

    // The first paint already has codes unless the server missed them entirely.
    if (initialStale || initialEmployees.length === 0) void sync();
    else setLoadingUsers(false);

    // Refresh when the tab regains focus, or once the cached list is past its TTL.
    const refresh = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const timer = window.setInterval(refresh, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      stopCamera();
    };
  }, [initialEmployees.length, initialStale, stopCamera]);

  const startCamera = async () => {
    setPhoto(null);
    setCameraReady(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      return setStatus({ type: "error", text: "Camera needs HTTPS (or localhost) and a supported browser." });
    }
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 } }, audio: false });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play().then(() => setCameraReady(true)).catch(() => setCameraReady(true));
        };
      }
      setCameraOn(true);
      setStatus(null);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      setStatus({
        type: "error",
        text: name === "NotAllowedError" ? "Camera permission denied. Allow camera in browser settings." :
          name === "NotFoundError" ? "No camera found on this device." : "Unable to start camera.",
      });
    }
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !cameraReady || !video.videoWidth) {
      return setStatus({ type: "info", text: "Camera is starting, please try again in a second." });
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 640 / (video.videoWidth || 640));
    canvas.width = (video.videoWidth || 640) * scale;
    canvas.height = (video.videoHeight || 480) * scale;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    setPhoto(canvas.toDataURL("image/jpeg", 0.7));
    stopCamera();
  };

  const getLocation = (): Promise<{ lat: number; lng: number }> =>
    new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => reject(new Error("Please allow location access to submit attendance.")),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });

  const submit = useCallback(async () => {
    if (!selected) return setStatus({ type: "error", text: "Please select employee code." });
    if (!photo) return setStatus({ type: "error", text: "Please capture your photo." });
    setSubmitting(true);
    setStatus({ type: "info", text: "Fetching live location..." });
    try {
      const { lat, lng } = await getLocation();
      setStatus({ type: "info", text: "Submitting attendance..." });
      const res = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ empCode: selected.empCode, entryType, locationType, lat, lng, image: photo }),
      });
      const d = await res.json();
      if (d.success) {
        setStatus({ type: "success", text: d.message });
        setPhoto(null);
        setEmpCode("");
      } else {
        setStatus({ type: "error", text: d.message || "Submission failed" });
      }
    } catch (e) {
      setStatus({ type: "error", text: e instanceof Error ? e.message : "Submission failed" });
    } finally {
      setSubmitting(false);
    }
  }, [selected, photo, entryType, locationType]);

  const input =
    "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";
  const label = "mb-1 block text-sm font-medium text-slate-700";

  return (
    <main className="min-h-screen bg-gradient-to-br from-indigo-50 to-slate-100 px-4 py-10">
      <div className="mx-auto max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h1 className="text-2xl font-bold text-slate-900">Employee Attendance</h1>
        <p className="mb-6 text-sm text-slate-500">{new Date().toDateString()}</p>

        <div className="space-y-4">
          <div>
            <label className={label}>Employee Code</label>
            <select className={input} value={empCode} onChange={(e) => setEmpCode(e.target.value)} disabled={loadingUsers}>
              <option value="">
                {sorted.length > 0
                  ? "Select employee code"
                  : loadingUsers
                    ? "Loading..."
                    : "No employees found"}
              </option>
              {sorted.map((e) => (
                <option key={e.empCode} value={e.empCode}>{e.empCode}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={label}>Employee Name</label>
            <input className={`${input} bg-slate-50`} value={selected?.empName ?? ""} readOnly placeholder="Auto-filled" />
          </div>
          <div>
            <label className={label}>Email ID</label>
            <input className={`${input} bg-slate-50`} value={selected?.email ?? ""} readOnly placeholder="Auto-filled" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Entry Type</label>
              <select className={input} value={entryType} onChange={(e) => setEntryType(e.target.value)}>
                <option>In</option>
                <option>Out</option>
              </select>
            </div>
            <div>
              <label className={label}>{entryType === "In" ? "CheckIn" : "CheckOut"} Location</label>
              <select className={input} value={locationType} onChange={(e) => setLocationType(e.target.value)}>
                <option>In office</option>
                <option>Out office</option>
              </select>
            </div>
          </div>

          <div>
            <label className={label}>Photo</label>
            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-slate-300 bg-slate-50">
              <video ref={videoRef} className={`h-full w-full -scale-x-100 object-cover ${cameraOn ? "" : "hidden"}`} playsInline muted autoPlay />
              {cameraOn ? null : photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="Captured" className="h-full w-full object-cover" />
              ) : (
                <span className="text-sm text-slate-400">No photo captured</span>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              {cameraOn ? (
                <button onClick={capture} disabled={!cameraReady} className="flex-1 rounded-lg bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-700 disabled:opacity-60">{cameraReady ? "Capture" : "Starting camera..."}</button>
              ) : null}
              {cameraOn ? null : (
                <button onClick={startCamera} className="flex-1 rounded-lg bg-slate-800 py-2 font-medium text-white hover:bg-slate-900">
                  {photo ? "Retake Photo" : "Open Camera"}
                </button>
              )}
            </div>
          </div>

          {status && (
            <div className={`rounded-lg px-3 py-2 text-sm ${
              status.type === "success" ? "bg-emerald-50 text-emerald-800" : status.type === "error" ? "bg-red-50 text-red-700" : "bg-indigo-50 text-indigo-700"
            }`}>{status.text}</div>
          )}

          <button
            onClick={submit}
            disabled={submitting || loadingUsers}
            className="w-full rounded-lg bg-indigo-600 py-3 font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {submitting ? "Please wait..." : "Submit Attendance"}
          </button>
        </div>
      </div>
    </main>
  );
}
