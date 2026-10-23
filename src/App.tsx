import { useEffect, useState } from "react";

type ItineraryRow = Record<string, string>;

type ApiResponse = {
  success?: boolean;
  user?: { email?: string; googleId?: string };
  data?: ItineraryRow[];
  count?: number;
  error?: string;
  connectUrl?: string;
  message?: string;
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

function App() {
  const [authMessage, setAuthMessage] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState("");

  const [itineraryRows, setItineraryRows] = useState<ItineraryRow[]>([]);
  const [isLoadingItinerary, setIsLoadingItinerary] = useState(false);
  const [itineraryError, setItineraryError] = useState("");
  const [needsSheetsConnection, setNeedsSheetsConnection] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Restore the existing app login after a page refresh or OAuth redirect.
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
    return () => {
      cancelled = true;
    };
  }, []);

  // Google Identity Services sign-in. The client ID is public and is embedded at build time.
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
            setAuthMessage("Google identity verified. Loading your itinerary…");
          } catch (error) {
            setAuthMessage(
              error instanceof Error
                ? error.message
                : "Google verification failed. Please try again.",
            );
          } finally {
            setIsVerifying(false);
          }
        },
      });

      window.google.accounts.id.renderButton(button, {
        theme: "outline",
        size: "large",
        text: "signin_with",
      });
    };

    setupGoogleSignIn();
    if (!window.google?.accounts.id) timer = setInterval(setupGoogleSignIn, 500);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  // Load rows from the connected Google Sheet whenever a user session is available.
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
            setNeedsSheetsConnection(
              response.status === 403 || Boolean(result.connectUrl),
            );
            setItineraryError(result.error || `Could not load itinerary (HTTP ${response.status}).`);
          }
          return;
        }

        if (!cancelled) {
          setItineraryRows(Array.isArray(result.data) ? result.data : []);
          setItineraryError("");
          setNeedsSheetsConnection(false);
          setAuthMessage("Signed in. Itinerary loaded from Google Sheets.");
        }
      } catch (error) {
        if (!cancelled) {
          setItineraryError(
            error instanceof Error ? error.message : "Could not load itinerary.",
          );
        }
      } finally {
        if (!cancelled) setIsLoadingItinerary(false);
      }
    }

    void loadItinerary();
    return () => {
      cancelled = true;
    };
  }, [verifiedEmail, refreshKey]);

  const headers = itineraryRows.length > 0 ? Object.keys(itineraryRows[0]) : [];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Shared travel companion
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              South Island Campervan Trip
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Your itinerary, loaded from Google Sheets
            </p>
          </div>
          {verifiedEmail && (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <p className="text-sm text-slate-600">Signed in as {verifiedEmail}</p>
              <button
                type="button"
                onClick={() => window.location.assign("/api/sheets/connect")}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-100"
              >
                {needsSheetsConnection ? "Connect Google Sheets" : "Reconnect Google Sheets"}
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">Google account</h2>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              {verifiedEmail ? (
                <p className="text-sm text-emerald-700">Google identity verified: {verifiedEmail}</p>
              ) : (
                <p className="text-sm text-slate-600">
                  Sign in with an approved Google account to view the shared itinerary.
                </p>
              )}
              {authMessage && (
                <p className="mt-1 text-sm text-slate-500" aria-live="polite">
                  {authMessage}
                </p>
              )}
              {isVerifying && <p className="mt-1 text-sm text-slate-500">Verifying account…</p>}
            </div>
            <div id="google-sign-in-button" className="min-h-10" />
          </div>
        </section>

        {verifiedEmail && (
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Itinerary</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {isLoadingItinerary
                    ? "Loading rows from your sheet…"
                    : `${itineraryRows.length} itinerary row${itineraryRows.length === 1 ? "" : "s"}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                disabled={isLoadingItinerary}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoadingItinerary ? "Refreshing…" : "Refresh itinerary"}
              </button>
            </div>

            {isLoadingItinerary && (
              <div className="px-5 py-8 text-sm text-slate-500" role="status">
                Loading your shared itinerary…
              </div>
            )}

            {!isLoadingItinerary && itineraryError && (
              <div className="m-5 rounded-xl border border-amber-200 bg-amber-50 p-4" role="alert">
                <p className="font-semibold text-amber-900">Itinerary could not be loaded</p>
                <p className="mt-1 text-sm text-amber-800">{itineraryError}</p>
                {needsSheetsConnection && (
                  <button
                    type="button"
                    onClick={() => window.location.assign("/api/sheets/connect")}
                    className="mt-3 rounded-lg bg-amber-900 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-950"
                  >
                    Connect Google Sheets
                  </button>
                )}
              </div>
            )}

            {!isLoadingItinerary && !itineraryError && itineraryRows.length === 0 && (
              <div className="px-5 py-8 text-sm text-slate-500">
                The connection worked, but the selected sheet tab has no itinerary rows yet.
              </div>
            )}

            {!isLoadingItinerary && !itineraryError && itineraryRows.length > 0 && (
              <div className="max-w-full overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      {headers.map((header) => (
                        <th
                          key={header}
                          scope="col"
                          className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700"
                        >
                          {header.replace(/_/g, " ")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {itineraryRows.map((row, index) => (
                      <tr key={index} className="align-top hover:bg-emerald-50/40">
                        {headers.map((header) => (
                          <td key={header} className="min-w-32 max-w-sm whitespace-pre-wrap px-4 py-3 text-slate-700">
                            {row[header] || "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
