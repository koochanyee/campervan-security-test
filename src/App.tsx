import { useEffect, useMemo, useState } from "react";

type ItineraryRow = Record<string, string>;
type ViewName =
  | "home"
  | "checklist"
  | "companion"
  | "itinerary"
  | "expenses"
  | "memories"
  | "map";

type ApiResponse = {
  success?: boolean;
  user?: { email?: string; googleId?: string };
  data?: ItineraryRow[];
  count?: number;
  error?: string;
  connectUrl?: string;
  message?: string;
  supplementaryTabs?: Record<string, string[][]>;
  supplementaryError?: string;
};

type TripDay = {
  key: string;
  weekday: string;
  date: string;
  dateObject: Date | null;
};

type DayEntry = {
  key: string;
  label: string;
  value: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            options: { theme: string; size: string; text: string },
          ) => void;
        };
      };
    };
  }
}

const TRIP_YEAR = 2026;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseTripDate(label: string): Date | null {
  const match = label.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  if (month < 0 || day < 1 || day > 31) return null;
  const result = new Date(TRIP_YEAR, month, day);
  return result.getMonth() === month && result.getDate() === day ? result : null;
}

function dateIsSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function App() {
  const [authMessage, setAuthMessage] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [itineraryRows, setItineraryRows] = useState<ItineraryRow[]>([]);
  const [supplementaryTabs, setSupplementaryTabs] = useState<Record<string, string[][]>>({});
  const [isLoadingItinerary, setIsLoadingItinerary] = useState(false);
  const [itineraryError, setItineraryError] = useState("");
  const [needsSheetsConnection, setNeedsSheetsConnection] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [activeView, setActiveView] = useState<ViewName>("home");
  const [preTripChecklist, setPreTripChecklist] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    async function restoreSession() {
      try {
        const response = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const result = (await response.json()) as ApiResponse;
        if (!cancelled && result.success && result.user?.email) {
          setVerifiedEmail(result.user.email);
          setAuthMessage("Existing session restored.");
        }
      } catch (error) {
        console.error("Session restoration failed:", error);
      }
    }
    void restoreSession();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
    if (!clientId) {
      setAuthMessage("Google sign-in configuration is missing.");
      return;
    }

    let attempts = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const setupGoogleSignIn = () => {
      if (!window.google?.accounts.id) {
        attempts += 1;
        if (attempts >= 20 && timer) clearInterval(timer);
        return;
      }
      if (timer) clearInterval(timer);
      const button = document.getElementById("google-sign-in-button");
      if (!button) return;
      button.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response) => {
          setAuthMessage("Verifying Google account…");
          setIsVerifying(true);
          try {
            const result = await fetch("/api/auth/google", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ credential: response.credential }),
            });
            const data = (await result.json()) as ApiResponse;
            if (!result.ok || !data.success || !data.user?.email) {
              throw new Error(data.error || "Google verification failed.");
            }
            setVerifiedEmail(data.user.email);
            setAuthMessage("Google identity verified. Loading your trip dashboard…");
          } catch (error) {
            setAuthMessage(error instanceof Error ? error.message : "Google verification failed. Please try again.");
          } finally {
            setIsVerifying(false);
          }
        },
      });
      window.google.accounts.id.renderButton(button, { theme: "outline", size: "large", text: "signin_with" });
    };

    setupGoogleSignIn();
    if (!window.google?.accounts.id) timer = setInterval(setupGoogleSignIn, 500);
    return () => { if (timer) clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!verifiedEmail) return;
    let cancelled = false;
    async function loadItinerary() {
      setIsLoadingItinerary(true);
      setItineraryError("");
      setNeedsSheetsConnection(false);
      try {
        const response = await fetch("/api/itinerary", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const result = (await response.json()) as ApiResponse;
        if (!response.ok || !result.success) {
          if (!cancelled) {
            setItineraryRows([]);
            setNeedsSheetsConnection(response.status === 403 || Boolean(result.connectUrl));
            setItineraryError(result.error || `Could not load itinerary (HTTP ${response.status}).`);
          }
          return;
        }
        if (!cancelled) {
          const rows = Array.isArray(result.data) ? result.data : [];
          setItineraryRows(rows);
          setSupplementaryTabs(result.supplementaryTabs ?? {});
          setActiveDayIndex(0);
          setItineraryError("");
          setNeedsSheetsConnection(false);
          setAuthMessage("Signed in. Itinerary loaded from Google Sheets.");
        }
      } catch (error) {
        if (!cancelled) setItineraryError(error instanceof Error ? error.message : "Could not load itinerary.");
      } finally {
        if (!cancelled) setIsLoadingItinerary(false);
      }
    }
    void loadItinerary();
    return () => { cancelled = true; };
  }, [verifiedEmail, refreshKey]);

  const headerKeys = useMemo(() => (itineraryRows.length > 0 ? Object.keys(itineraryRows[0]) : []), [itineraryRows]);
  const labelKey = headerKeys[0] || "DAY";

  const tripDays = useMemo<TripDay[]>(() => {
    if (itineraryRows.length === 0 || headerKeys.length < 2) return [];
    const dateRow = itineraryRows[0];
    return headerKeys.slice(1).flatMap((key) => {
      const date = String(dateRow[key] ?? "").trim();
      if (!date) return [];
      return [{
        key,
        weekday: key.replace(/_\d+$/, "").replace(/_/g, " ").toUpperCase(),
        date,
        dateObject: parseTripDate(date),
      }];
    });
  }, [headerKeys, itineraryRows]);

  const safeDayIndex = tripDays.length > 0 ? Math.min(activeDayIndex, tripDays.length - 1) : 0;
  const selectedDay = tripDays[safeDayIndex];
  const today = new Date();
  const liveDayIndex = tripDays.findIndex((day) => day.dateObject && dateIsSameDay(day.dateObject, today));
  const dashboardDayIndex = liveDayIndex >= 0 ? liveDayIndex : safeDayIndex;
  const tripStart = tripDays[0]?.dateObject;
  const tripEnd = tripDays[tripDays.length - 1]?.dateObject;
  const isTripOngoing = Boolean(tripStart && tripEnd && today >= tripStart && today <= tripEnd);
  const isTripUpcoming = Boolean(tripStart && today < tripStart);
  const dateRange = tripDays.length > 0
    ? `${tripDays[0].date}–${tripDays[tripDays.length - 1].date} ${TRIP_YEAR}`
    : "Trip dates will appear here";

  const getEntriesForDay = (day: TripDay | undefined): DayEntry[] => {
    if (!day || itineraryRows.length < 2) return [];
    return itineraryRows.slice(1).flatMap((row, index) => {
      const value = String(row[day.key] ?? "").trim();
      if (!value) return [];
      const label = String(row[labelKey] ?? "").trim() || `Itinerary item ${index + 1}`;
      return [{ key: `${day.key}-${index}`, label, value }];
    });
  };

  const dayEntries = useMemo<DayEntry[]>(() => {
    if (!selectedDay || itineraryRows.length < 2) return [];
    return itineraryRows.slice(1).flatMap((row, index) => {
      const value = String(row[selectedDay.key] ?? "").trim();
      if (!value) return [];
      const label = String(row[labelKey] ?? "").trim() || `Itinerary item ${index + 1}`;
      return [{ key: `${selectedDay.key}-${index}`, label, value }];
    });
  }, [selectedDay, itineraryRows, labelKey]);
   
  const dashboardPreviewDays = tripDays
  .slice(dashboardDayIndex, dashboardDayIndex + 3)
  .map((day) => {
    const entries = getEntriesForDay(day);

    const route =
      entries.find((entry) => /^route$/i.test(entry.label))?.value ?? "";

    const highlights = entries
      .filter((entry) =>
        /^(morning|afternoon|evening)$/i.test(entry.label)
      )
      .flatMap((entry) =>
        entry.value
          .split(/\n+/)
          .map((line) =>
            line
              .trim()
              .replace(/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–:]?\s*/i, "")
          )
          .filter(
            (line) =>
              line.length > 4 &&
              !/^(breakfast|lunch|dinner|self cook|rest|free and easy|sleep|depart|continue|drive to|drive toward|arrive|check in|check out|pack|refuel)/i.test(line)
          )
      )
      .slice(0, 3);

    return { day, route, highlights };
  });
  
  const categorized = useMemo(() => {
    const groups: Record<string, DayEntry[]> = {
      route: [],
      places: [],
      stay: [],
      other: [],
    };
    for (const entry of dayEntries) {
      const label = entry.label.toLowerCase();
      if (/route|drive|driving|destination|distance|travel time|departure|arrival|transport/.test(label)) groups.route.push(entry);
      else if (/attraction|place|visit|activity|experience|sight|stop|location|walk|hike|tour/.test(label)) groups.places.push(entry);
      else if (/camp|campsite|accommodation|hotel|booking|check.?in|reservation|stay|overnight/.test(label)) groups.stay.push(entry);
      else groups.other.push(entry);
    }
    return groups;
  }, [dayEntries]);

  const navigateToItinerary = (dayIndex = dashboardDayIndex) => {
    setActiveDayIndex(Math.max(0, Math.min(dayIndex, Math.max(0, tripDays.length - 1))));
    setActiveView("itinerary");
  };

  return (
    <div className="min-h-screen bg-[#f4f6f4] pb-24 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <button type="button" onClick={() => setActiveView("home")} className="text-left">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-800">Shared travel companion</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">New Zealand Road Trip</h1>
            <p className="mt-1 text-sm text-slate-500">South Island · {dateRange}</p>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {verifiedEmail && <span className="text-sm text-slate-600">{verifiedEmail}</span>}
            {verifiedEmail && <button type="button" onClick={() => window.location.assign("/api/sheets/connect")} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">{needsSheetsConnection ? "Connect Sheets" : "Reconnect Sheets"}</button>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-7">
        {!verifiedEmail && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Google account</h2>
            <p className="mt-2 text-sm text-slate-600">Sign in with an approved Google account to view your shared travel companion.</p>
            {authMessage && <p className="mt-2 text-sm text-slate-500" aria-live="polite">{authMessage}</p>}
            {isVerifying && <p className="mt-2 text-sm text-slate-500">Verifying account…</p>}
            <div id="google-sign-in-button" className="mt-4 min-h-10" />
          </section>
        )}

        {verifiedEmail && (
          <>
            {itineraryError && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="alert">
                <p className="font-semibold text-amber-900">Itinerary could not be loaded</p>
                <p className="mt-1 text-sm text-amber-800">{itineraryError}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setRefreshKey((n) => n + 1)} className="rounded-lg bg-amber-900 px-3 py-2 text-sm font-semibold text-white">Try again</button>
                  {needsSheetsConnection && <button type="button" onClick={() => window.location.assign("/api/sheets/connect")} className="rounded-lg border border-amber-900 px-3 py-2 text-sm font-semibold text-amber-950">Connect Google Sheets</button>}
                </div>
              </div>
            )}

            {isLoadingItinerary && <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600" role="status">Loading your trip details…</div>}

            {!isLoadingItinerary && !itineraryError && activeView === "home" && (
              <div className="space-y-6">
                <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-950 via-emerald-800 to-teal-700 p-6 text-white shadow-sm sm:p-8">
                  <div className="absolute -right-10 -top-12 h-56 w-56 rounded-full border border-white/10" />
                  <div className="absolute -right-1 top-8 h-36 w-36 rounded-full border border-white/10" />
                  <div className="relative max-w-2xl">
                    <span className="inline-flex items-center rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider">{isTripOngoing ? "During the trip" : isTripUpcoming ? "Your trip is coming up" : "Your trip dashboard"}</span>
                    <div className="mt-5 flex items-start gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-3xl" aria-hidden="true">🚐</div>
                      <div>
                        <h2 className="text-2xl font-bold sm:text-3xl">New Zealand Road Trip</h2>
                        <p className="mt-2 text-sm text-emerald-50 sm:text-base">South Island · {dateRange}</p>
                        <p className="mt-3 max-w-xl text-sm leading-6 text-emerald-50">Your shared home for the daily plan, trip reminders, expenses and memories.</p>
                      </div>
                    </div>
                    <button   type="button"   onClick={() => setActiveView("checklist")}   className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-bold text-emerald-950 shadow-sm hover:bg-emerald-50" >   START JOURNEY ✈️🚐   <span aria-hidden="true"> →</span> </button>
                  </div>
                </section>

                <section className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">
                      Trip preview
                    </p>
                    <h2 className="mt-1 text-xl font-bold">
                      Your journey at a glance
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Upcoming routes and attraction highlights.
                    </p>

                    <div className="mt-4 space-y-3">
                      {dashboardPreviewDays.map(({ day, route, highlights }, index) => (
                        <button
                          key={day.key}
                          type="button"
                          onClick={() => {
                            setActiveDayIndex(dashboardDayIndex + index);
                            setActiveView("itinerary");
                          }}
                          className="w-full rounded-xl border border-slate-200 p-4 text-left hover:border-emerald-500 hover:bg-emerald-50/40"
                        >
                          <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                            Day {dashboardDayIndex + index + 1} · {day.weekday}
                          </p>
                          <h3 className="mt-1 font-bold">{day.date}</h3>
                  
                          {route && (
                            <p className="mt-2 text-sm font-medium text-slate-700">
                              {route}
                            </p>
                          )}
                  
                          {highlights.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {highlights.map((highlight, highlightIndex) => (
                                <li
                                  key={`${day.key}-${highlightIndex}`}
                                  className="line-clamp-2 text-sm text-slate-600"
                                >
                                  • {highlight}
                                </li>
                              ))}
                            </ul>
                          )}
                  
                          <p className="mt-3 text-xs font-semibold text-emerald-800">
                            View this day →
                          </p>
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => navigateToItinerary()}
                      disabled={tripDays.length === 0}
                      className="mt-4 w-full rounded-xl bg-emerald-800 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-900 disabled:opacity-50"
                    >
                      Open full itinerary →
                    </button>
                  </div>
                  
                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
                    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-2xl" aria-hidden="true">💳</div>
                        <div>
                          <h2 className="font-bold">Trip expenses</h2>
                          <p className="mt-1 text-sm text-slate-600">Expense tracking is not connected yet.</p>
                          <p className="mt-2 text-xs text-slate-500">No spending total is shown until expense data is added.</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setActiveView("expenses")} className="mt-4 text-sm font-semibold text-emerald-800 hover:underlontinue|drive to|drive toward|arrive|check in|check out|pack|refuel)/i.test(line)
          )
      )
      .slice(0, 3);

    return { day, route, highlights };
  });
  
  const categorized = useMemo(() => {
    const groups: Record<string, DayEntry[]> = {
      route: [],
      places: [],
      stay: [],
      other: [],
    };
    for (const entry of dayEntries) {
      const label = entry.label.toLowerCase();
      if (/route|drive|driving|destination|distance|travel time|departure|arrival|transport/.test(label)) groups.route.push(entry);
      else if (/attraction|place|visit|activity|experience|sight|stop|location|walk|hike|tour/.test(label)) groups.places.push(entry);
      else if (/camp|campsite|accommodation|hotel|booking|check.?in|reservation|stay|overnight/.test(label)) groups.stay.push(entry);
      else groups.other.push(entry);
    }
    return groups;
  }, [dayEntries]);

  const navigateToItinerary = (dayIndex = dashboardDayIndex) => {
    setActiveDayIndex(Math.max(0, Math.min(dayIndex, Math.max(0, tripDays.length - 1))));
    setActiveView("itinerary");
  };

  return (
    <div className="min-h-screen bg-[#f4f6f4] pb-24 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <button type="button" onClick={() => setActiveView("home")} className="text-left">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-800">Shared travel companion</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">New Zealand Road Trip</h1>
            <p className="mt-1 text-sm text-slate-500">South Island · {dateRange}</p>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {verifiedEmail && <span className="text-sm text-slate-600">{verifiedEmail}</span>}
            {verifiedEmail && <button type="button" onClick={() => window.location.assign("/api/sheets/connect")} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">{needsSheetsConnection ? "Connect Sheets" : "Reconnect Sheets"}</button>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-7">
        {!verifiedEmail && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Google account</h2>
            <p className="mt-2 text-sm text-slate-600">Sign in with an approved Google account to view your shared travel companion.</p>
            {authMessage && <p className="mt-2 text-sm text-slate-500" aria-live="polite">{authMessage}</p>}
            {isVerifying && <p className="mt-2 text-sm text-slate-500">Verifying account…</p>}
            <div id="google-sign-in-button" className="mt-4 min-h-10" />
          </section>
        )}

        {verifiedEmail && (
          <>
            {itineraryError && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="alert">
                <p className="font-semibold text-amber-900">Itinerary could not be loaded</p>
                <p className="mt-1 text-sm text-amber-800">{itineraryError}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setRefreshKey((n) => n + 1)} className="rounded-lg bg-amber-900 px-3 py-2 text-sm font-semibold text-white">Try again</button>
                  {needsSheetsConnection && <button type="button" onClick={() => window.location.assign("/api/sheets/connect")} className="rounded-lg border border-amber-900 px-3 py-2 text-sm font-semibold text-amber-950">Connect Google Sheets</button>}
                </div>
              </div>
            )}

            {isLoadingItinerary && <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600" role="status">Loading your trip details…</div>}

            {!isLoadingItinerary && !itineraryError && activeView === "home" && (
              <div className="space-y-6">
                <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-950 via-emerald-800 to-teal-700 p-6 text-white shadow-sm sm:p-8">
                  <div className="absolute -right-10 -top-12 h-56 w-56 rounded-full border border-white/10" />
                  <div className="absolute -right-1 top-8 h-36 w-36 rounded-full border border-white/10" />
                  <div className="relative max-w-2xl">
                    <span className="inline-flex items-center rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider">{isTripOngoing ? "During the trip" : isTripUpcoming ? "Your trip is coming up" : "Your trip dashboard"}</span>
                    <div className="mt-5 flex items-start gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-3xl" aria-hidden="true">🚐</div>
                      <div>
                        <h2 className="text-2xl font-bold sm:text-3xl">New Zealand Road Trip</h2>
                        <p className="mt-2 text-sm text-emerald-50 sm:text-base">South Island · {dateRange}</p>
                        <p className="mt-3 max-w-xl text-sm leading-6 text-emerald-50">Your shared home for the daily plan, trip reminders, expenses and memories.</p>
                      </div>
                    </div>
                    <button   type="button"   onClick={() => setActiveView("checklist")}   className="mt-6 rounded-xl bg-white px-5 py-3 text-sm font-bold text-emerald-950 shadow-sm hover:bg-emerald-50" >   START JOURNEY ✈️🚐   <span aria-hidden="true"> →</span> </button>
                  </div>
                </section>

                <section className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">
                      Trip preview
                    </p>
                    <h2 className="mt-1 text-xl font-bold">
                      Your journey at a glance
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Upcoming routes and attraction highlights.
                    </p>

                    <div className="mt-4 space-y-3">
                      {dashboardPreviewDays.map(({ day, route, highlights }, index) => (
                        <button
                          key={day.key}
                          type="button"
                          onClick={() => {
                            setActiveDayIndex(dashboardDayIndex + index);
                            setActiveView("itinerary");
                          }}
                          className="w-full rounded-xl border border-slate-200 p-4 text-left hover:border-emerald-500 hover:bg-emerald-50/40"
                        >
                          <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">
                            Day {dashboardDayIndex + index + 1} · {day.weekday}
                          </p>
                          <h3 className="mt-1 font-bold">{day.date}</h3>
                  
                          {route && (
                            <p className="mt-2 text-sm font-medium text-slate-700">
                              {route}
                            </p>
                          )}
                  
                          {highlights.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {highlights.map((highlight, highlightIndex) => (
                                <li
                                  key={`${day.key}-${highlightIndex}`}
                                  className="line-clamp-2 text-sm text-slate-600"
                                >
                                  • {highlight}
                                </li>
                              ))}
                            </ul>
                          )}
                  
                          <p className="mt-3 text-xs font-semibold text-emerald-800">
                            View this day →
                          </p>
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => navigateToItinerary()}
                      disabled={tripDays.length === 0}
                      className="mt-4 w-full rounded-xl bg-emerald-800 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-900 disabled:opacity-50"
                    >
                      Open full itinerary →
                    </button>
                  </div>
                  
                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
                    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-2xl" aria-hidden="true">💳</div>
                        <div>
                          <h2 className="font-bold">Trip expenses</h2>
                          <p className="mt-1 text-sm text-slate-600">Expense tracking is not connected yet.</p>
                          <p className="mt-2 text-xs text-slate-500">No spending total is shown until expense data is added.</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setActiveView("expenses")} className="mt-4 text-sm font-semibold text-emerald-800 hover:underline">Open expenses →</button>
                    </section>
                    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-50 text-2xl" aria-hidden="true">🔔</div>
                        <div>
                          <h2 className="font-bold">Reminders</h2>
                          <p className="mt-1 text-sm text-slate-600">Booking and check-in reminders are not connected yet.</p>
                          <p className="mt-2 text-xs text-slate-500">No pending count is shown until reminders are configured.</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setActiveView("itinerary")} className="mt-4 text-sm font-semibold text-emerald-800 hover:underline">Review trip plan →</button>
                    </section>
                  </div>
                </section>

                <section>
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold">Your trip</h2>
                      <p className="mt-1 text-sm text-slate-500">Jump to a part of your travel companion.</p>
                    </div>
                    <button type="button" onClick={() => setRefreshKey((n) => n + 1)} disabled={isLoadingItinerary} className="text-sm font-semibold text-emerald-800 hover:underline disabled:opacity-50">Refresh data</button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      { view: "itinerary" as ViewName, icon: "🗓️", title: "Itinerary", description: "Daily plans and destinations", available: true },
                      { view: "expenses" as ViewName, icon: "💳", title: "Expenses", description: "Shared trip spending", available: false },
                      { view: "memories" as ViewName, icon: "📸", title: "Memories", description: "Photos and shared notes", available: false },
                      { view: "map" as ViewName, icon: "🗺️", title: "Map", description: "Routes and saved places", available: false },
                    ].map((item) => (
                      <button key={item.view} type="button" onClick={() => setActiveView(item.view)} className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow">
                        <span className="text-2xl" aria-hidden="true">{item.icon}</span>
                        <span className="mt-3 block font-bold">{item.title}</span>
                        <span className="mt-1 block text-sm text-slate-500">{item.description}</span>
                        {!item.available && <span className="mt-3 inline-block rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500">Not connected yet</span>}
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {!isLoadingItinerary && !itineraryError && activeView === "itinerary" && (
              <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">Daily itinerary</p>
                    <h2 className="mt-1 text-2xl font-bold">Choose your day</h2>
                    <p className="mt-1 text-sm text-slate-500">{tripDays.length} travel days · details read live from Google Sheets</p>
                  </div>
                  <button type="button" onClick={() => setActiveView("home")} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50">← Dashboard</button>
                </div>
                {tripDays.length === 0 ? (
                  <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No travel dates were found in the spreadsheet's second header row.</p>
                ) : (
                  <>
                    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
                      {tripDays.map((day, index) => {
                        const selected = index === safeDayIndex;
                        return (
                          <button key={day.key} type="button" aria-pressed={selected} onClick={() => setActiveDayIndex(index)} className={`min-w-[100px] shrink-0 rounded-xl border p-3 text-left transition ${selected ? "border-emerald-700 bg-emerald-50 ring-1 ring-emerald-700" : "border-slate-200 bg-white hover:border-emerald-300"}`}>
                            <span className={`block text-xs font-bold ${selected ? "text-emerald-800" : "text-slate-500"}`}>{day.weekday}</span>
                            <span className="mt-1 block font-semibold">{day.date}</span>
                            <span className="mt-1 block text-xs text-slate-500">Day {index + 1}</span>
                          </button>
                        );
                      })}
                    </div>

                    {selectedDay && (
                      <section className="overflow-hidden rounded-2xl border border-slate-200">
                        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 px-4 py-4 sm:px-5">
                          <div>
                            <p className="text-xs font-bold uppercase tracking-[0.15em] text-emerald-800">{selectedDay.weekday} · Day {safeDayIndex + 1}</p>
                            <h3 className="mt-1 text-xl font-bold">{selectedDay.date}</h3>
                          </div>
                          <div className="flex gap-2">
                            <button type="button" disabled={safeDayIndex === 0} onClick={() => setActiveDayIndex((i) => Math.max(i - 1, 0))} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-40">Previous</button>
                            <button type="button" disabled={safeDayIndex >= tripDays.length - 1} onClick={() => setActiveDayIndex((i) => Math.min(i + 1, tripDays.length - 1))} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-40">Next</button>
                          </div>
                        </div>
                        {dayEntries.length === 0 ? (
                          <p className="px-5 py-8 text-sm text-slate-500">No itinerary details have been entered for this day yet.</p>
                        ) : (
                          <div className="divide-y divide-slate-100">
                            {dayEntries.map((entry) => <div key={entry.key} className="grid gap-1 px-4 py-4 sm:grid-cols-[minmax(9rem,0.35fr)_minmax(0,1fr)] sm:gap-5 sm:px-5"><h4 className="text-sm font-semibold text-slate-600">{entry.label}</h4><p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-900">{entry.value}</p></div>)}
                          </div>
                        )}
                        <div className="border-t border-slate-100 p-4">
                          <h4 className="font-semibold text-slate-900">
                            Practical Tips & Date-Specific Notes
                          </h4>

                          {Object.entries(supplementaryTabs)
                            .filter(
                              ([tabName]) =>
                                /^\d{1,2}\s+nov$/i.test(tabName) &&
                                selectedDay.date.toLowerCase().includes(tabName.toLowerCase())
                            )
                            .map(([tabName, rows]) => (
                              <div key={tabName} className="mt-3">
                                <h5 className="text-sm font-semibold text-emerald-800">
                                  {tabName} — Supplementary Notes
                                </h5>
                                {rows.map((row, rowIndex) => {
                                  const text = row
                                    .map((cell) => String(cell ?? "").trim())
                                    .filter(Boolean)
                                    .join(" · ");

                                  return text ? (
                                    <p
                                      key={`${tabName}-${rowIndex}`}
                                      className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700"
                                    >
                                      {text}
                                    </p>
                                  ) : null;
                                })}
                              </div>                        
                            ))}

                          
                          <div className="mt-4 rounded-xl bg-slate-50 p-3">  
                          <h5 className="text-sm font-semibold text-slate-800">    
                          👕 Practical Tips & Layering Notes  
                          </h5>
  
                          {(() => {    
                          const rows = supplementaryTabs["Layering"] ?? [];    
                          const rawText = rows      
                          .flat()      
                          .map((cell) => String(cell ?? "").trim())      
                          .find((cell) => cell.startsWith("{"));                          
   
                           if (!rawText) {
                                return (
                                  <p className="mt-2 text-sm text-slate-500">
                                    No layering notes are available.
                                  </p>
                                );
                              }

                              try {
                                const parsed = JSON.parse(rawText) as {
                                  itinerary?: Array<{
                                    day?: string;
                                    date?: string;
                                    location?: string;
                                    weather_and_activity?: string;
                                    icons?: string[];
                                    wear?: string;
                                  }>;
                                  core_golden_rule?: string;
                                };

                                const entries = parsed.itinerary ?? [];
                                const selectedDate = selectedDay?.date ?? "";
                          
                                const normalizeDate = (value: string) =>
                                  value.toLowerCase().replace(/\s+/g, " ").trim();

                                const layering = entries.find((entry) => {
                                  const date = normalizeDate(entry.date ?? "");
                                  const selected = normalizeDate(selectedDate);

                                  if (!date || !selected) return false;
                                  if (date === selected) return true;

                                  // Support entries covering a date range, e.g. "19–20 Nov".
                                  const range = date.match(
                                    /^(\d{1,2})\s*[–-]\s*(\d{1,2})\s+([a-z]+)$/
                                  );
                                  const single = selected.match(/^(\d{1,2})\s+([a-z]+)$/);

                                  return Boolean(
                                    range &&
                                    single &&
                                    range[3] === single[2] &&
                                    Number(single[1]) >= Number(range[1]) &&
                                    Number(single[1]) <= Number(range[2])
                                  );
                                });

                                return (
                                  <div className="mt-2 space-y-3">
                                    {layering ? (
                                      <>
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <p className="font-semibold text-slate-800">
                                            {layering.location ?? layering.day}
                                          </p>
                                          <span className="text-xs text-slate-600">
                                            {layering.weather_and_activity}
                                          </span>
                                        </div>

                                        {layering.icons && layering.icons.length > 0 && (
                                          <p className="text-xl" aria-label="Suggested clothing">
                                            {layering.icons.join(" ")}
                                          </p>
                                        )}

                                        <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                                          {layering.wear}
                                        </p>
                                      </>
                                    ) : (
                                      <p className="text-sm text-slate-500">
                                        No layering recommendation matches {selectedDate || "this day"}.
                                      </p>
                                    )}

                                    {parsed.core_golden_rule && (
                                      <div className="border-t border-slate-200 pt-3">
                                        <p className="text-xs font-semibold text-slate-700">
                                          Packing tip
                                        </p>
                                        <p className="mt-1 text-sm leading-6 text-slate-600">
                                          {parsed.core_golden_rule}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                );
                              } catch {
                                return (
                                  <p className="mt-2 text-sm text-amber-700">
                                    Layering data could not be read. Please check the JSON in the
                                    Layering spreadsheet tab.
                                  </p>
                                );
                              }
                            })()}
                          </div>
                        </div>
                        <div className="grid gap-3 border-t border-slate-100 bg-white p-4 sm:grid-cols-3">
                          <InfoPanel icon="🛣️" title="Route & destinations" entries={categorized.route} empty="Route details are not labelled in the sheet yet." />
                          <InfoPanel icon="📍" title="Places to visit" entries={categorized.places} empty="Place details are not labelled in the sheet yet." />
                          <InfoPanel icon="🏕️" title="Stay & bookings" entries={categorized.stay} empty="Stay details are not labelled in the sheet yet." />
                        </div>
                        <div className="border-t border-slate-100 bg-slate-50 p-4">
                          <div className="flex items-start gap-3">
                            <span className="text-xl" aria-hidden="true">📸</span>
                            <div><h4 className="font-semibold">Travel memories</h4><p className="mt-1 text-sm text-slate-600">Shared photos, memories and private notes are planned, but that feature is not connected yet.</p></div>
                          </div>
                        </div>
                      </section>
                    )}
                  </>
                )}
              </section>
            )}

            {!isLoadingItinerary && !itineraryError && activeView === "checklist" && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
                <button
                  type="button"
                  onClick={() => setActiveView("home")}
                  className="text-sm font-semibold text-emerald-800 hover:underline"
                >
                  ← Back to dashboard
                </button>

                <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">
                  Before departure
                </p>
                <h2 className="mt-2 text-2xl font-bold">Travel checklist</h2>
                <p className="mt-2 text-sm text-slate-600">
                  Check the essentials before starting your South Island journey.
                </p>

                <div className="mt-5 space-y-3">
                  {[
                    { id: "passport", label: "Passport and travel documents" },
                    { id: "wallet", label: "Wallet, bank cards and cash" },
                    { id: "visa", label: "Visa / NZeTA requirements checked" },
                    { id: "booking", label: "Flight, campervan and accommodation bookings" },
                    { id: "driving", label: "Driving licence and required permits" },
                    { id: "insurance", label: "Travel and vehicle insurance" },
                    { id: "phone", label: "Phone, chargers and power bank" },
                    { id: "medicine", label: "Personal medication and essentials" },
                  ].map((item) => (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(preTripChecklist[item.id])}
                        onChange={(event) =>
                          setPreTripChecklist((previous) => ({
                            ...previous,
                            [item.id]: event.target.checked,
                          }))
                        }
                        className="mt-1 h-4 w-4 accent-emerald-700"
                      />
                      <span className="text-sm font-medium text-slate-800">
                        {item.label}
                      </span>
                    </label>
                  ))}
                </div>

                <p className="mt-4 text-sm text-slate-500">
                  Completed: {Object.values(preTripChecklist).filter(Boolean).length} of 8 items
                </p>

                <button
                  type="button"
                  onClick={() => setActiveView("companion")}
                  className="mt-6 w-full rounded-xl bg-emerald-800 px-5 py-3 font-bold text-white hover:bg-emerald-900"
                >
                  See Companion →
                </button>
              </section>
            )}

            {!isLoadingItinerary && !itineraryError && activeView === "companion" && (
              <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
                <button
                  type="button"
                  onClick={() => setActiveView("checklist")}
                  className="text-sm font-semibold text-emerald-800 hover:underline"
                >
                  ← Back to checklist
                </button>

                <div className="mt-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-50 text-3xl">
                  ❤️
                </div>

                <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">
                  Your travel companion
                </p>
                <h2 className="mt-2 text-2xl font-bold">Two travellers, one journey</h2>
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  Your shared South Island trip, itinerary and travel memories belong
                  in one place. Sign in using your own approved Google account.
                </p>

                <div className="mt-5 rounded-xl border border-slate-200 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Currently signed in
                  </p>
                  <p className="mt-1 break-all font-medium text-slate-900">
                    {verifiedEmail}
                  </p>
                </div>

                <p className="mt-4 text-sm text-slate-500">
                  Shared companion profiles and live shared editing are not connected yet.
                </p>

                <button
                  type="button"
                  onClick={() => navigateToItinerary()}
                  disabled={tripDays.length === 0}
                  className="mt-6 w-full rounded-xl bg-emerald-800 px-5 py-3 font-bold text-white hover:bg-emerald-900 disabled:opacity-50"
                >
                  Show Itinerary →
                </button>
              </section>
            )}            

            {!isLoadingItinerary && !itineraryError && ["expenses", "memories", "map"].includes(activeView) && (
              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
                <button type="button" onClick={() => setActiveView("home")} className="text-sm font-semibold text-emerald-800 hover:underline">← Back to dashboard</button>
                <div className="mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-3xl" aria-hidden="true">{activeView === "expenses" ? "💳" : activeView === "memories" ? "📸" : "🗺️"}</div>
                <h2 className="mt-4 text-2xl font-bold">{activeView === "expenses" ? "Trip expenses" : activeView === "memories" ? "Travel memories" : "Trip map"}</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">{activeView === "expenses" ? "Shared expense tracking has not been connected yet. No spending total is being fabricated." : activeView === "memories" ? "Shared photos, travel notes and private notes are planned for a later feature. No memories have been saved by this screen yet." : "A route map has not been connected yet. This screen does not currently save locations or calculate routes."}</p>
                <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Your Google Sheets itinerary remains connected and unchanged.</div>
              </section>
            )}
          </>
        )}
      </main>

      {verifiedEmail && (
        <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <div className="mx-auto grid max-w-2xl grid-cols-5 gap-1 py-2">
            {[
              { view: "home" as ViewName, icon: "⌂", label: "Home" },
              { view: "itinerary" as ViewName, icon: "▤", label: "Itinerary" },
              { view: "expenses" as ViewName, icon: "＄", label: "Expenses" },
              { view: "memories" as ViewName, icon: "♡", label: "Memories" },
              { view: "map" as ViewName, icon: "⌖", label: "Map" },
            ].map((item) => (
              <button key={item.view} type="button" onClick={() => setActiveView(item.view)} className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-medium transition ${activeView === item.view ? "bg-emerald-50 text-emerald-900" : "text-slate-500 hover:bg-slate-50"}`} aria-current={activeView === item.view ? "page" : undefined}>
                <span className="text-xl leading-none" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

function InfoPanel({ icon, title, entries, empty }: { icon: string; title: string; entries: DayEntry[]; empty: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="flex items-center gap-2"><span aria-hidden="true">{icon}</span><h4 className="text-sm font-semibold">{title}</h4></div>
      {entries.length === 0 ? <p className="mt-2 text-xs leading-5 text-slate-500">{empty}</p> : <div className="mt-2 space-y-3">{entries.map((entry) => <div key={entry.key}><p className="text-xs font-semibold text-slate-700">{entry.label}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">{entry.value}</p></div>)}</div>}
    </div>
  );
}

export default App;
