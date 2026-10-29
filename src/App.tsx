import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

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
  memories?: TripMemory[];
  expenses?: TripExpense[];
  checklistItems?: ChecklistItem[];
  items?: ChecklistItem[];
  item?: ChecklistItem;
  trips?: TripConfigSummary[];
  trip?: TripConfigSummary;
};

type TripConfigSummary = { id: string; name: string; itineraryTab?: string };

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

type TripMemory = {
  memory_id: string;
  trip_date: string;
  attraction: string;
  author_email: string;
  content: string;
  created_at?: string;
  updated_at?: string;
  photo_ids?: string;
};

type TripExpense = {
  expense_id: string;
  date: string;
  description: string;
  category: string;
  amount: number;
  currency: string;
  paid_by: string;
  expense_type: "pre-trip" | "actual-trip";
  notes?: string;
  source?: string;
};

type ChecklistItem = {
  item_id: string;
  category: string;
  item: string;
  ralph_status?: string;
  june_status?: string;
  quantity?: string;
  notes?: string;
  due_date?: string;
  checklist_type?: "packing" | "todo";
  must_have?: boolean;
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

function getMemoryPhotoIds(photoIds?: string): string[] {
  if (!photoIds) return [];
  try {
    const parsed: unknown = JSON.parse(photoIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : [];
  } catch {
    return photoIds.split(",").map((id) => id.trim()).filter(Boolean);
  }
}

function googleMapsUrl(route: string): string {
  const cleaned = route.replace(/[⭐❤️💙🔌✈️🚐🛣️]/gu, "").trim();
  const isFlight = /\b(KUL|SIN)\b|flight|airport transfer/i.test(cleaned);
  const normalisePlace = (place: string) => place.replace(/\bCC\b/gi, "Christchurch").replace(/\bChch\b/gi, "Christchurch").replace(/\bMt\s+Cook\b/gi, "Aoraki / Mount Cook").trim();
  const parts = cleaned.split(/\s*(?:→|➜|⟶|->|—>|\bto\b)\s*/i).map(normalisePlace).filter(Boolean);
  if (!isFlight && parts.length >= 2) {
    const origin = parts[0];
    const destination = parts[parts.length - 1];
    const waypoints = parts.slice(1, -1);
    const params = new URLSearchParams({ api: "1", origin, destination, travelmode: "driving" });
    if (waypoints.length) params.set("waypoints", waypoints.join("|"));
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(normalisePlace(cleaned || route))}`;
}

const TRIP_YEAR = 2026;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function formatMemoryDate(date: Date): string {
  return `${date.getDate()} ${date.toLocaleDateString("en-GB", { month: "short" })}`;
}

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
  const [showDriveAccessModal, setShowDriveAccessModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeDayIndex, setActiveDayIndex] = useState(0);
  const [activeView, setActiveViewState] = useState<ViewName>("home");
  const [selectedTripId, setSelectedTripId] = useState("");
  const [viewHistory, setViewHistory] = useState<ViewName[]>([]);
  const [showAddTripInfo, setShowAddTripInfo] = useState(false);
  const [trips, setTrips] = useState<TripConfigSummary[]>([]);
  const [tripNameDraft, setTripNameDraft] = useState("");
  const [tripSheetIdDraft, setTripSheetIdDraft] = useState("");
  const [tripTabDraft, setTripTabDraft] = useState("FINAL ITINERARY");
  const [tripMessage, setTripMessage] = useState("");
  const [tripSaving, setTripSaving] = useState(false);
  const [showHighlightPhoto, setShowHighlightPhoto] = useState(() => {
    try { return typeof window === "undefined" || window.localStorage.getItem("campervan-show-highlight-photo") !== "false"; }
    catch { return true; }
  });

  useEffect(() => {
    try { window.localStorage.setItem("campervan-show-highlight-photo", String(showHighlightPhoto)); }
    catch { /* Preference remains usable for this session if browser storage is unavailable. */ }
  }, [showHighlightPhoto]);

  const setActiveView = (nextView: ViewName) => {
    if (nextView === activeView) return;
    setViewHistory((history) => [...history, activeView]);
    setActiveViewState(nextView);
    if (typeof window !== "undefined") {
      window.history.pushState({ campervanView: nextView }, "");
    }
  };

  const goBack = () => {
    if (viewHistory.length === 0) {
      goToDashboard();
      return;
    }
    setActiveViewState(viewHistory[viewHistory.length - 1]);
    setViewHistory(viewHistory.slice(0, -1));
  };

  const goToDashboard = () => {
    setViewHistory([]);
    setActiveViewState("home");
  };

  useEffect(() => {
    const handlePopState = () => {
      if (viewHistory.length === 0) {
        setActiveViewState("home");
        return;
      }
      setActiveViewState(viewHistory[viewHistory.length - 1]);
      setViewHistory(viewHistory.slice(0, -1));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [viewHistory]);

  const returnToTripSelection = () => {
    setSelectedTripId("");
    setViewHistory([]);
    setActiveViewState("home");
    setItineraryRows([]);
    setSupplementaryTabs({});
    setActiveDayIndex(0);
  };
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [checklistCategoryIndex, setChecklistCategoryIndex] = useState(0);
  const [checklistMessage, setChecklistMessage] = useState("");
  const [checklistSavingId, setChecklistSavingId] = useState("");
  const [checklistTouchStart, setChecklistTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [expenses, setExpenses] = useState<TripExpense[]>([]);
  const [expenseMessage, setExpenseMessage] = useState("");
  const [expenseSaving, setExpenseSaving] = useState(false);
  const [expenseType, setExpenseType] = useState<"pre-trip" | "actual-trip">("pre-trip");
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("Other");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCurrency, setExpenseCurrency] = useState("NZD");
  const [expensePaidBy, setExpensePaidBy] = useState("Ralph");
  const [expenseNotes, setExpenseNotes] = useState("");
  const [memories, setMemories] = useState<TripMemory[]>([]);
  const [memoryAttraction, setMemoryAttraction] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryDate, setMemoryDate] = useState(() => formatMemoryDate(new Date()));
  const [memoryPreviewOpen, setMemoryPreviewOpen] = useState(false);
  const [isSavingMemory, setIsSavingMemory] = useState(false);
  const [memoryMessage, setMemoryMessage] = useState("");
  const [locationDrafts, setLocationDrafts] = useState<Record<string, string>>({});
  const [locationSaving, setLocationSaving] = useState<string>("");
  const [locationMessage, setLocationMessage] = useState("");
  const [locationModalSession, setLocationModalSession] = useState<string | null>(null);
  const [memoryPhotoFiles, setMemoryPhotoFiles] = useState<File[]>([]);
  const [isDetectingPlace, setIsDetectingPlace] = useState(false);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);

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
            setAuthMessage("Google identity verified. Loading trip selection…");
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
    async function loadTrips() {
      try {
        const response = await fetch("/api/trips", { credentials: "same-origin", cache: "no-store" });
        const result = await response.json() as ApiResponse;
        if (!response.ok || !result.success) throw new Error(result.error || "Could not load trips.");
        if (!cancelled) setTrips(Array.isArray(result.trips) ? result.trips : []);
      } catch (error) {
        if (!cancelled) setTripMessage(error instanceof Error ? error.message : "Could not load trips.");
      }
    }
    void loadTrips();
    return () => { cancelled = true; };
  }, [verifiedEmail]);

  const addTrip = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTripSaving(true); setTripMessage("");
    try {
      const response = await fetch("/api/trips", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: tripNameDraft.trim(), sheetId: tripSheetIdDraft.trim(), itineraryTab: tripTabDraft.trim() || "FINAL ITINERARY" }) });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success || !result.trip) throw new Error(result.error || "Could not add this trip.");
      setTrips((current) => [...current, result.trip as TripConfigSummary]);
      setTripNameDraft(""); setTripSheetIdDraft(""); setTripTabDraft("FINAL ITINERARY"); setShowAddTripInfo(false);
      setTripMessage("Trip connected successfully.");
    } catch (error) { setTripMessage(error instanceof Error ? error.message : "Could not add this trip."); }
    finally { setTripSaving(false); }
  };

  useEffect(() => {
    if (!verifiedEmail || !selectedTripId) return;
    let cancelled = false;
    async function loadItinerary() {
      setIsLoadingItinerary(true);
      setItineraryError("");
      try {
        const response = await fetch(`/api/itinerary?tripId=${encodeURIComponent(selectedTripId)}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const result = (await response.json()) as ApiResponse;
        if (!response.ok || !result.success) {
          if (!cancelled) {
            setItineraryRows([]);
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
  }, [verifiedEmail, selectedTripId, refreshKey]);

  useEffect(() => {
    if (!verifiedEmail || !selectedTripId) return;
    let cancelled = false;
    async function loadMemories() {
      try {
        const response = await fetch(`/api/memories?tripId=${encodeURIComponent(selectedTripId)}`, {
          method: "GET", credentials: "same-origin", cache: "no-store",
        });
        const result = (await response.json()) as ApiResponse;
        if (!response.ok || !result.success) throw new Error(result.error || "Could not load travel memories.");
        if (!cancelled) setMemories(Array.isArray(result.memories) ? result.memories : []);
      } catch (error) {
        if (!cancelled) setMemoryMessage(error instanceof Error ? error.message : "Could not load travel memories.");
      }
    }
    void loadMemories();
    return () => { cancelled = true; };
  }, [verifiedEmail, selectedTripId]);

  useEffect(() => {
    if (!verifiedEmail || !selectedTripId) return;
    let cancelled = false;
    async function loadExpensesAndChecklist() {
      try {
        const [expenseResponse, checklistResponse] = await Promise.all([
          fetch(`/api/expenses?tripId=${encodeURIComponent(selectedTripId)}`, { credentials: "same-origin", cache: "no-store" }),
          fetch(`/api/checklist?tripId=${encodeURIComponent(selectedTripId)}`, { credentials: "same-origin", cache: "no-store" }),
        ]);
        const expenseResult = await expenseResponse.json() as ApiResponse;
        const checklistResult = await checklistResponse.json() as ApiResponse;
        if (!expenseResponse.ok || !expenseResult.success) throw new Error(expenseResult.error || "Could not load expenses.");
        if (!checklistResponse.ok || !checklistResult.success) throw new Error(checklistResult.error || "Could not load the shared checklist.");
        if (!cancelled) {
          setExpenses(Array.isArray(expenseResult.expenses) ? expenseResult.expenses : []);
          setChecklistItems(Array.isArray(checklistResult.checklistItems) ? checklistResult.checklistItems : Array.isArray(checklistResult.items) ? checklistResult.items : []);
          setExpenseMessage("");
          setChecklistMessage("");
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Could not load shared trip records.";
          setExpenseMessage(message);
          setChecklistMessage(message);
        }
      }
    }
    void loadExpensesAndChecklist();
    return () => { cancelled = true; };
  }, [verifiedEmail, selectedTripId]);

  const saveExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(expenseAmount);
    if (!expenseDate || !expenseDescription.trim() || !Number.isFinite(amount) || amount <= 0) {
      setExpenseMessage("Enter a date, description and amount greater than zero.");
      return;
    }
    setExpenseSaving(true);
    setExpenseMessage("");
    const record: TripExpense = {
      expense_id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
      date: expenseDate,
      description: expenseDescription.trim(),
      category: expenseCategory,
      amount,
      currency: expenseCurrency,
      paid_by: expensePaidBy,
      expense_type: expenseType,
      notes: expenseNotes.trim(),
    };
    try {
      const response = await fetch(`/api/expenses?tripId=${encodeURIComponent(selectedTripId)}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...record, tripId: selectedTripId }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.error || "Could not save the expense.");
      const refreshed = await fetch(`/api/expenses?tripId=${encodeURIComponent(selectedTripId)}`, { credentials: "same-origin", cache: "no-store" });
      const refreshedResult = await refreshed.json() as ApiResponse;
      if (refreshed.ok && refreshedResult.success) setExpenses(Array.isArray(refreshedResult.expenses) ? refreshedResult.expenses : [...expenses, record]);
      setExpenseDescription(""); setExpenseAmount(""); setExpenseNotes("");
      setExpenseMessage("Expense saved to the shared trip sheet.");
    } catch (error) {
      setExpenseMessage(error instanceof Error ? error.message : "Could not save the expense.");
    } finally { setExpenseSaving(false); }
  };

  const setChecklistStatus = async (item: ChecklistItem, status: "" | "✓" | "x") => {
    const currentName = verifiedEmail.toLowerCase() === "koochanyee@gmail.com" ? "Ralph" : "June";
    const field = currentName === "Ralph" ? "ralph_status" : "june_status";
    const updated = { ...item, [field]: status } as ChecklistItem;
    setChecklistSavingId(item.item_id);
    setChecklistMessage("");
    setChecklistItems((current) => current.map((entry) => entry.item_id === item.item_id ? updated : entry));
    try {
      const response = await fetch(`/api/checklist?tripId=${encodeURIComponent(selectedTripId)}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: item.item_id, status, tripId: selectedTripId }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.error || "Could not sync checklist status.");
      setChecklistMessage("Checklist synced to Google Sheets.");
    } catch (error) {
      setChecklistItems((current) => current.map((entry) => entry.item_id === item.item_id ? item : entry));
      setChecklistMessage(error instanceof Error ? error.message : "Could not sync checklist status.");
    } finally { setChecklistSavingId(""); }
  };

  const saveMemory = async () => {
    if (!memoryDate || !memoryAttraction.trim() || !memoryContent.trim()) {
      setMemoryMessage("Please enter the trip date, attraction and memory.");
      return;
    }
    setIsSavingMemory(true);
    setMemoryMessage("");
    try {
      if (memoryPhotoFiles.length > 4) throw new Error("Choose up to 4 photos per memory.");
      const photos = await Promise.all(memoryPhotoFiles.map(async (file) => {
        if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
        if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is larger than 4 MB. Please choose a smaller photo.`);
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        return { name: file.name, mime_type: file.type, data_base64: dataBase64 };
      }));
      const response = await fetch(`/api/memories?tripId=${encodeURIComponent(selectedTripId)}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tripId: selectedTripId,
          memory_id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          trip_date: memoryDate,
          attraction: memoryAttraction.trim(),
          content: memoryContent.trim(),
          photos,
        }),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.error || "Could not save this memory.");
      const refreshed = await fetch(`/api/memories?tripId=${encodeURIComponent(selectedTripId)}`, { credentials: "same-origin", cache: "no-store" });
      const refreshedResult = (await refreshed.json()) as ApiResponse;
      if (refreshed.ok && refreshedResult.success) setMemories(Array.isArray(refreshedResult.memories) ? refreshedResult.memories : []);
      setMemoryAttraction("");
      setMemoryContent("");
      setMemoryPhotoFiles([]);
      setMemoryPreviewOpen(false);
      setMemoryMessage("Memory saved and shared with your travel companion.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save this memory.";
      setMemoryMessage(message);
      if (memoryPhotoFiles.length > 0 && /drive|permission|authorization|scope|access/i.test(message)) {
        setShowDriveAccessModal(true);
      }
    } finally {
      setIsSavingMemory(false);
    }
  };

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

  const welcomeName = verifiedEmail.toLowerCase() === "koochanyee@gmail.com" ? "Ralph" : verifiedEmail.toLowerCase() === "wookahwai@gmail.com" ? "June" : "there";
  const checklistCategories = Array.from(new Set(checklistItems.map((item) => item.category.trim()).filter(Boolean)));
  const safeChecklistCategoryIndex = checklistCategories.length ? Math.min(checklistCategoryIndex, checklistCategories.length - 1) : 0;
  const selectedChecklistCategory = checklistCategories[safeChecklistCategoryIndex] ?? "";
  const selectedChecklistItems = checklistItems.filter((item) => item.category === selectedChecklistCategory);
  const currentChecklistField = verifiedEmail.toLowerCase() === "koochanyee@gmail.com" ? "ralph_status" : "june_status";
  const checklistCompletedCount = checklistItems.filter((item) => item[currentChecklistField] === "✓").length;
  const preTripExpenses = expenses.filter((expense) => expense.expense_type === "pre-trip");
  const actualTripExpenses = expenses.filter((expense) => expense.expense_type === "actual-trip");
  const formatMoney = (amount: number, currency: string) => `${currency || "NZD"} ${Number(amount || 0).toFixed(2)}`;
  const formatExpenseTotal = (records: TripExpense[]) => {
    const totals = records.reduce<Record<string, number>>((acc, item) => {
      const currency = item.currency || "NZD";
      acc[currency] = (acc[currency] ?? 0) + Number(item.amount || 0);
      return acc;
    }, {});
    return Object.keys(totals).length ? Object.entries(totals).map(([currency, total]) => formatMoney(total, currency)).join(" · ") : formatMoney(0, "NZD");
  };

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
              .replace(/^\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*[-–:,]?\s*/i, "")
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

  const sessionLocationRows = useMemo(() => {
    const tabName = Object.keys(supplementaryTabs).find((name) => /^session\s+locations?$/i.test(name));
    const rows = tabName ? (supplementaryTabs[tabName] ?? []) : [];
    if (rows.length < 2) return [] as Array<{ date: string; session: string; location: string }>;
    const headers = rows[0].map((cell) => String(cell ?? "").trim().toLowerCase());
    const dateIndex = headers.findIndex((h) => h === "date" || h.includes("trip date"));
    const sessionIndex = headers.findIndex((h) => h === "session" || h.includes("time of day"));
    const locationIndex = headers.findIndex((h) => h === "planned location" || h === "location");
    if (dateIndex < 0 || sessionIndex < 0 || locationIndex < 0) return [];
    return rows.slice(1).map((row) => ({
      date: String(row[dateIndex] ?? "").trim(),
      session: String(row[sessionIndex] ?? "").trim(),
      location: String(row[locationIndex] ?? "").trim(),
    })).filter((row) => row.date && row.session);
  }, [supplementaryTabs]);

  const normalizeTripDate = (value: string) => value.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const getSessionLocation = (session: string) => {
    const selectedDate = normalizeTripDate(selectedDay?.date ?? "");
    const match = sessionLocationRows.find((row) => normalizeTripDate(row.date) === selectedDate && row.session.toLowerCase() === session.toLowerCase());
    return match?.location ?? "";
  };

  const openSessionLocationEditor = (session: string) => {
    const key = `${selectedDay?.date ?? ""}|${session}`;
    setLocationDrafts((current) => ({ ...current, [key]: current[key] ?? getSessionLocation(session) }));
    setLocationMessage("");
    setLocationModalSession(session);
  };

  const detectMemoryPlace = async () => {
    if (!navigator.geolocation) {
      setMemoryMessage("Location detection is not supported by this browser.");
      return;
    }
    setIsDetectingPlace(true);
    setMemoryMessage("Requesting your location permission…");
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude } = position.coords;
      try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`);
        if (!response.ok) throw new Error("Could not resolve the GPS coordinates to a place name.");
        const result = await response.json() as { name?: string; display_name?: string; address?: Record<string, string> };
        const address = result.address ?? {};
        const place = result.name || address.tourism || address.amenity || address.natural || address.road || address.suburb || result.display_name;
        setMemoryAttraction(place || `GPS ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
        setMemoryMessage(`Place detected from GPS (${latitude.toFixed(4)}, ${longitude.toFixed(4)}). Please check the place name before saving.`);
      } catch (error) {
        setMemoryAttraction(`GPS ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
        setMemoryMessage(error instanceof Error ? `${error.message} Coordinates added instead.` : "Coordinates added instead.");
      } finally {
        setIsDetectingPlace(false);
      }
    }, (error) => {
      setIsDetectingPlace(false);
      setMemoryMessage(error.code === error.PERMISSION_DENIED ? "Location permission was denied. You can type the place name instead." : "Could not detect location. Please try again or enter the place manually.");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  };

  const saveSessionLocation = async (session: string) => {
    const key = `${selectedDay?.date ?? ""}|${session}`;
    const newLocation = (locationDrafts[key] ?? getSessionLocation(session)).trim();
    const oldLocation = getSessionLocation(session);
    if (!selectedDay || !newLocation) { setLocationMessage("Enter a planned location before saving."); return; }
    setLocationSaving(key);
    setLocationMessage("");
    try {
      const response = await fetch(`/api/session-location?tripId=${encodeURIComponent(selectedTripId)}`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId: selectedTripId, date: selectedDay.date, Date: selectedDay.date, session, Session: session, oldLocation, newLocation, "Planned location": newLocation }),
      });
      const result = (await response.json()) as ApiResponse;
      if (!response.ok || !result.success) throw new Error(result.error || "Could not save the planned location.");
      setSupplementaryTabs((current) => {
        const existingTabName = Object.keys(current).find((name) => /^session\s+locations?$/i.test(name));
        const tabName = existingTabName || "SESSION LOCATION";
        const rows = (current[tabName] ?? [["Date", "Session", "Planned location"]]).map((row) => [...row]);
        if (rows.length) {
          const headers = rows[0].map((cell) => String(cell ?? "").trim().toLowerCase());
          const dateIndex = headers.findIndex((h) => h === "date" || h.includes("trip date"));
          const sessionIndex = headers.findIndex((h) => h === "session" || h.includes("time of day"));
          const locationIndex = headers.findIndex((h) => h === "planned location" || h === "location");
          const rowIndex = rows.findIndex((row, i) => i > 0 && normalizeTripDate(String(row[dateIndex] ?? "")) === normalizeTripDate(selectedDay.date) && String(row[sessionIndex] ?? "").toLowerCase() === session.toLowerCase());
          if (rowIndex > 0 && locationIndex >= 0) rows[rowIndex][locationIndex] = newLocation;
          else if (locationIndex >= 0 && dateIndex >= 0 && sessionIndex >= 0) rows.push([selectedDay.date, session, newLocation]);
        }
        return { ...current, [tabName]: rows };
      });
      setLocationDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
      setLocationMessage(`${session} location saved.`);
      setLocationModalSession(null);
    } catch (error) {
      setLocationMessage(error instanceof Error ? error.message : "Could not save the planned location.");
    } finally { setLocationSaving(""); }
  };

  const navigateToItinerary = (dayIndex = dashboardDayIndex) => {
    setActiveDayIndex(Math.max(0, Math.min(dayIndex, Math.max(0, tripDays.length - 1))));
    setActiveView("itinerary");
  };
  const selectedTrip = trips.find((trip) => trip.id === selectedTripId);

  return (
    <div className="min-h-screen bg-[#f4f6f4] pb-40 text-slate-900">
      <style>{`@keyframes itinerarySlideIn { from { opacity: .65; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }`}</style>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <button type="button" onClick={() => setActiveView("home")} className="text-left">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-800">Shared travel companion</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{selectedTrip?.name || "Travel Companion"}</h1>
            <p className="mt-1 text-sm text-slate-500">{dateRange}</p>
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {verifiedEmail && <span className="text-sm font-semibold text-slate-700">Welcome, {welcomeName}</span>}
            {verifiedEmail && selectedTripId && activeView !== "home" && (
              <button type="button" onClick={goBack} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">← Back</button>
            )}
            {verifiedEmail && selectedTripId && activeView !== "home" && (
              <button type="button" onClick={goToDashboard} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Dashboard</button>
            )}
            {verifiedEmail && selectedTripId && activeView === "home" && (
              <button type="button" onClick={returnToTripSelection} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50">Trip selection</button>
            )}
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

        {verifiedEmail && !selectedTripId && (
          <section className="mx-auto max-w-3xl space-y-5">
            <div className="rounded-3xl bg-gradient-to-br from-emerald-950 via-emerald-800 to-teal-700 p-6 text-white shadow-sm sm:p-8">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-100">Shared travel companion</p>
              <h2 className="mt-3 text-3xl font-bold">Welcome, {welcomeName} 👋</h2>
              <p className="mt-2 text-sm text-emerald-50">Choose a trip to open its dashboard. Trip details are not loaded until you select one.</p>
            </div>
            {trips.map((trip) => (
              <article key={trip.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-4xl" aria-hidden="true">🚐</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Available trip</p>
                    <h3 className="mt-1 text-xl font-bold">{trip.name}</h3>
                    <p className="mt-1 text-sm text-slate-600">Shared trip · Google Sheets itinerary</p>
                  </div>
                  <button type="button" onClick={() => { setSelectedTripId(trip.id); setViewHistory([]); setActiveViewState("home"); setRefreshKey((n) => n + 1); }} className="rounded-xl bg-emerald-800 px-5 py-3 text-sm font-bold text-white hover:bg-emerald-900">Open trip →</button>
                </div>
              </article>
            ))}
            {trips.length === 0 && <p className="rounded-xl bg-white p-4 text-sm text-slate-600">No trips are registered yet. Add a Google Sheet to begin.</p>}
            <article className="rounded-2xl border border-dashed border-slate-300 bg-white p-5 sm:p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-2xl" aria-hidden="true">＋</div>
                <div className="flex-1">
                  <h3 className="font-bold">Add trip itinerary</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">Connect another Google Sheet or create a new itinerary in the app.</p>
                  <button type="button" onClick={() => setShowAddTripInfo(true)} className="mt-3 rounded-lg border border-emerald-800 px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50">Add a trip</button>
                </div>
              </div>
            </article>
            {showAddTripInfo && (
              <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="add-trip-title">
                <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl sm:p-6">
                  <div className="flex items-start justify-between gap-3">
                    <h3 id="add-trip-title" className="text-lg font-bold">Add trip itinerary</h3>
                    <button type="button" onClick={() => setShowAddTripInfo(false)} className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100" aria-label="Close">✕</button>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-600">Connect an existing Google Sheet that you can access. The itinerary tab must already exist. The app will keep this trip's expenses, checklist and locations separate.</p>
                  <form onSubmit={addTrip} className="mt-4 space-y-3">
                    <label className="block text-sm font-semibold">Trip name<input required minLength={2} maxLength={100} value={tripNameDraft} onChange={(event) => setTripNameDraft(event.target.value)} placeholder="e.g. Japan Spring Trip" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>
                    <label className="block text-sm font-semibold">Google Sheets ID<input required value={tripSheetIdDraft} onChange={(event) => setTripSheetIdDraft(event.target.value)} placeholder="Paste the ID from the Google Sheets URL" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>
                    <label className="block text-sm font-semibold">Itinerary tab name<input required value={tripTabDraft} onChange={(event) => setTripTabDraft(event.target.value)} placeholder="FINAL ITINERARY" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>
                    {tripMessage && <p className="text-sm text-slate-600" aria-live="polite">{tripMessage}</p>}
                    <div className="flex gap-2"><button type="button" onClick={() => setShowAddTripInfo(false)} className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-sm font-semibold">Cancel</button><button type="submit" disabled={tripSaving} className="flex-1 rounded-lg bg-emerald-800 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{tripSaving ? "Checking sheet…" : "Connect trip"}</button></div>
                  </form>
                </div>
              </div>
            )}
          </section>
        )}

        {verifiedEmail && selectedTripId && (
          <>
            {selectedTripId && itineraryError && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="alert">
                <p className="font-semibold text-amber-900">Itinerary could not be loaded</p>
                <p className="mt-1 text-sm text-amber-800">{itineraryError}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setRefreshKey((n) => n + 1)} className="rounded-lg bg-amber-900 px-3 py-2 text-sm font-semibold text-white">Try again</button>
                </div>
              </div>
            )}

            {selectedTripId && isLoadingItinerary && <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600" role="status">Loading your trip details…</div>}

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
                        <h2 className="text-2xl font-bold sm:text-3xl">Welcome, {welcomeName}</h2>
                        <p className="mt-1 text-sm font-semibold text-emerald-50">{selectedTrip?.name || "Selected trip"}</p>
                        <p className="mt-2 text-sm text-emerald-50 sm:text-base">{dateRange}</p>
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
                    <button type="button" onClick={() => setRefreshKey((n) => n + 1)} disabled={isLoadingItinerary} className="text-sm font-semibold text-emerald-800 hover:underline disabled:opacity-50">Refresh itinerary</button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {[
                      { view: "itinerary" as ViewName, icon: "🗓️", title: "Itinerary", description: "Daily plans and destinations", available: true },
                      { view: "checklist" as ViewName, icon: "🎒", title: "Things to do & bring", description: "Shared pre-trip checklist", available: true },
                      { view: "expenses" as ViewName, icon: "💳", title: "Expenses", description: "Pre-trip and actual spending", available: true },
                      { view: "memories" as ViewName, icon: "📸", title: "Memories", description: "Shared travel memories", available: true },
                      { view: "map" as ViewName, icon: "🗺️", title: "Map", description: "Routes and saved places", available: true },
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
              <section onTouchStart={(event) => setTouchStart({ x: event.touches[0].clientX, y: event.touches[0].clientY })} onTouchEnd={(event) => { if (!touchStart) return; const dx = event.changedTouches[0].clientX - touchStart.x; const dy = event.changedTouches[0].clientY - touchStart.y; if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.25) setActiveDayIndex((index) => Math.max(0, Math.min(tripDays.length - 1, index + (dx < 0 ? 1 : -1)))); setTouchStart(null); }} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">Daily itinerary</p>
                    <h2 className="mt-1 text-xs font-medium text-slate-500">Swipe or tap a day</h2>
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
                    <div className="flex items-center justify-between gap-3 text-xs text-slate-500"><span>← Swipe the itinerary card to change day →</span><span className="font-semibold">{safeDayIndex + 1} / {tripDays.length}</span></div>
                    <div className="flex justify-center gap-1.5" aria-label={`Day ${safeDayIndex + 1} of ${tripDays.length}`}>{tripDays.map((day, index) => <button key={`dot-${day.key}`} type="button" onClick={() => setActiveDayIndex(index)} aria-label={`Go to ${day.date}`} aria-current={index === safeDayIndex ? "step" : undefined} className={`h-1.5 rounded-full transition-all duration-300 ${index === safeDayIndex ? "w-7 bg-emerald-700" : "w-1.5 bg-slate-300 hover:bg-emerald-400"}`} />)}</div>

                    {selectedDay && (
                      <section key={selectedDay.key} style={{ animation: "itinerarySlideIn 200ms ease-out" }} className="overflow-hidden rounded-2xl border border-slate-200 transition-all duration-300">
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
                          <div className="space-y-4 p-4 sm:p-5">
                            <section
                              className={`relative overflow-hidden rounded-2xl border border-slate-300 p-4 shadow-sm sm:p-5 ${showHighlightPhoto ? "text-white" : "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-slate-900"}`}
                              style={showHighlightPhoto ? {
                                backgroundImage: "linear-gradient(110deg, rgba(8, 24, 38, 0.88), rgba(8, 24, 38, 0.62)), url(https://images.unsplash.com/photo-1469521669194-babb45599def?auto=format&fit=crop&w=1600&q=85)",
                                backgroundSize: "cover",
                                backgroundPosition: "center",
                              } : undefined}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h4 className="text-lg font-bold">⭐ Today Highlight</h4>
                                <button type="button" onClick={() => setShowHighlightPhoto((enabled) => !enabled)} aria-pressed={showHighlightPhoto} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${showHighlightPhoto ? "border-white/60 bg-black/25 text-white hover:bg-black/40" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
                                  {showHighlightPhoto ? "Photo background: On" : "Photo background: Off"}
                                </button>
                              </div>
                              <div className="mt-4 space-y-4">
                                <div><p className="font-semibold">🛣️ Route</p>{categorized.route.filter((entry) => /route|destination|distance|departure|arrival|transport/i.test(entry.label)).length ? categorized.route.filter((entry) => /route|destination|distance|departure|arrival|transport/i.test(entry.label)).map((entry) => <p key={entry.key} className="mt-1 whitespace-pre-wrap text-sm leading-6">{entry.value}</p>) : <p className={`mt-1 text-sm ${showHighlightPhoto ? "text-white/80" : "text-slate-500"}`}>No route details entered for this day.</p>}</div>
                                <div><p className="font-semibold">🚐 Driving note</p>{categorized.route.filter((entry) => /drive|driving|travel time/i.test(entry.label)).length ? categorized.route.filter((entry) => /drive|driving|travel time/i.test(entry.label)).map((entry) => <p key={entry.key} className="mt-1 whitespace-pre-wrap text-sm leading-6">{entry.value}</p>) : <p className={`mt-1 text-sm ${showHighlightPhoto ? "text-white/80" : "text-slate-500"}`}>No separate driving note entered.</p>}</div>
                                <div><p className="font-semibold">⚡ Activity</p>{dashboardPreviewDays.find((item) => item.day.key === selectedDay.key)?.highlights.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6">{dashboardPreviewDays.find((item) => item.day.key === selectedDay.key)!.highlights.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}</ul> : <p className={`mt-1 text-sm ${showHighlightPhoto ? "text-white/80" : "text-slate-500"}`}>Activity highlights will appear here from the itinerary.</p>}</div>
                              </div>
                            </section>
                            <section className="space-y-3">
                              <h4 className="font-semibold">🕒 Daily Timeline</h4>
                              {(["Morning", "Afternoon", "Evening"] as const).map((session) => {
                                const entry = dayEntries.find((item) => item.label.trim().toLowerCase() === session.toLowerCase());
                                const savedLocation = getSessionLocation(session);
                                const lines = (entry?.value ?? "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
                                return <div key={session} className={`rounded-xl border p-4 ${lines.length ? "border-slate-200 bg-white" : "border-dashed border-slate-300 bg-slate-50/70"}`}>
                                  <div className="flex items-center gap-3"><h5 className={`font-bold ${lines.length ? "text-slate-900" : "text-slate-500"}`}>{session}</h5><span className="text-2xl" aria-hidden="true">{session === "Morning" ? "🧇" : session === "Afternoon" ? "🧆" : "🍲"}</span></div>
                                  {lines.length ? <div className="mt-3 space-y-2">{lines.map((line, i) => {
                                    const match = line.match(/^(\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)(?:\s*[-–:,]\s*|\s+)(.+)$/i);
                                    const mealWord = session === "Morning" ? /\b(breakfast)\b/i : session === "Afternoon" ? /\b(lunch)\b/i : /\b(dinner)\b/i;
                                    const text = match ? match[2] : line;
                                    const wordMatch = text.match(mealWord);
                                    return <div key={`${session}-${i}`} className="flex items-start gap-2 text-sm leading-6">{match && <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{match[1]}</span>}<span>{wordMatch ? <>{text.slice(0, wordMatch.index)}<strong>{wordMatch[0]}</strong>{text.slice((wordMatch.index ?? 0) + wordMatch[0].length)}</> : text}</span></div>;
                                  })}</div> : <p className="mt-2 text-xs text-slate-400">No planned activity</p>}
                                  <button type="button" onClick={() => openSessionLocationEditor(session)} className="mt-3 flex w-full items-start gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3 text-left transition hover:border-emerald-400 hover:bg-emerald-50/60"><span className="text-2xl" aria-hidden="true">📍</span><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-slate-600">Session & Location · Tap to edit</span><span className="mt-1 block whitespace-pre-wrap text-sm text-slate-800">{savedLocation || `Add a ${session.toLowerCase()} location`}</span></span><span className="text-sm font-semibold text-emerald-800">Edit</span></button>
                                </div>;
                              })}
                              {locationMessage && <p className="text-sm text-slate-600" aria-live="polite">{locationMessage}</p>}
                            </section>
                            <section className="rounded-xl border border-slate-200 p-4">
                              <h4 className="font-semibold">🏕️ Bookings & Charges</h4>
                              {categorized.stay.length ? categorized.stay.map((entry) => <div key={entry.key} className="mt-2"><p className="text-xs font-semibold text-slate-500">{entry.label}</p><p className="whitespace-pre-wrap text-sm leading-6">{entry.value}</p></div>) : <p className="mt-2 text-sm text-slate-500">No accommodation or booking details entered for this day.</p>}
                              {categorized.other.filter((entry) => /fee|charge|cost|price|booking|reservation|payment/i.test(entry.label)).map((entry) => <div key={entry.key} className="mt-2"><p className="text-xs font-semibold text-slate-500">{entry.label}</p><p className="whitespace-pre-wrap text-sm leading-6">{entry.value}</p></div>)}
                            </section>
                            <section className="rounded-xl border border-slate-200 p-4">
                              <h4 className="font-semibold">📍 Other Activities & Details</h4>
                              {categorized.places.length ? categorized.places.filter((entry) => !/^(morning|afternoon|evening)$/i.test(entry.label)).map((entry) => <div key={entry.key} className="mt-2"><p className="text-xs font-semibold text-slate-500">{entry.label}</p><p className="whitespace-pre-wrap text-sm leading-6">{entry.value}</p></div>) : <p className="mt-2 text-sm text-slate-500">No additional activity entries.</p>}
                            </section>
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
                                          <p className="text-4xl" aria-label="Suggested clothing">
                                            {layering.icons.map((icon) => /fleece|wool|yarn|🧶|🧵/i.test(icon) ? "🧶" : icon).join(" ")}
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
                          <div className="flex items-start justify-between gap-3"><div><h4 className="font-semibold">📸 Travel Memories</h4><p className="mt-1 text-sm text-slate-600">Shared notes saved for {selectedDay.date}.</p></div><button type="button" onClick={() => { setActiveView("memories"); }} className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold">Add memory</button></div>
                          {memories.filter((memory) => normalizeTripDate(memory.trip_date) === normalizeTripDate(selectedDay.date)).length ? <div className="mt-3 space-y-3">{memories.filter((memory) => normalizeTripDate(memory.trip_date) === normalizeTripDate(selectedDay.date)).map((memory) => <article key={memory.memory_id} className="rounded-lg border border-slate-200 bg-white p-3"><p className="font-semibold">{memory.attraction}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">{memory.content}</p>{getMemoryPhotoIds(memory.photo_ids).length > 0 && <div className="mt-3 grid grid-cols-2 gap-2">{getMemoryPhotoIds(memory.photo_ids).map((photoId) => <a key={photoId} href={`https://drive.google.com/uc?export=view&id=${encodeURIComponent(photoId)}`} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border border-slate-200"><img src={`https://drive.google.com/uc?export=view&id=${encodeURIComponent(photoId)}`} alt={`Photo for ${memory.attraction}`} loading="lazy" className="h-28 w-full object-cover" /><span className="block px-2 py-1 text-xs font-semibold text-emerald-800">Open photo ↗</span></a>)}</div>}<p className="mt-2 text-xs text-slate-500">Shared by {memory.author_email || "trip companion"}</p></article>)}</div> : <p className="mt-3 text-sm text-slate-500">No memories saved for this day yet.</p>}
                        </div>
                      </section>
                    )}
                  </>
                )}
              </section>
            )}

            {!isLoadingItinerary && !itineraryError && activeView === "checklist" && (
              <section
                onTouchStart={(event) => setChecklistTouchStart({ x: event.touches[0].clientX, y: event.touches[0].clientY })}
                onTouchEnd={(event) => {
                  if (!checklistTouchStart || checklistCategories.length < 2) return;
                  const dx = event.changedTouches[0].clientX - checklistTouchStart.x;
                  const dy = event.changedTouches[0].clientY - checklistTouchStart.y;
                  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                    setChecklistCategoryIndex((index) => (index + (dx < 0 ? 1 : -1) + checklistCategories.length) % checklistCategories.length);
                  }
                  setChecklistTouchStart(null);
                }}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
              >
                <button type="button" onClick={goToDashboard} className="text-sm font-semibold text-emerald-800 hover:underline">← Back to dashboard</button>
                <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-emerald-800">Before departure</p>
                <h2 className="mt-2 text-2xl font-bold">Things to do & bring</h2>
                <p className="mt-2 text-sm text-slate-600">Your own status is saved separately from {welcomeName === "Ralph" ? "June" : "Ralph"}. Choose Done, To do or Ignored for each item.</p>
                <div className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">Completed: {checklistCompletedCount} of {checklistItems.length} items</div>
                {checklistCategories.length > 0 ? (
                  <>
                    <div className="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-2" aria-label="Checklist categories">
                      {checklistCategories.map((category, index) => (
                        <button key={category} type="button" aria-pressed={index === safeChecklistCategoryIndex} onClick={() => setChecklistCategoryIndex(index)} className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition ${index === safeChecklistCategoryIndex ? "border-emerald-800 bg-emerald-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-emerald-300"}`}>{category}</button>
                      ))}
                    </div>
                    <div key={selectedChecklistCategory} className="mt-3 space-y-3" style={{ animation: "itinerarySlideIn 220ms ease-out" }}>
                      {selectedChecklistItems.map((item) => {
                        const status = String(item[currentChecklistField] ?? "");
                        return (
                          <article key={item.item_id} className={`rounded-xl border p-4 transition ${status === "x" ? "border-slate-200 bg-slate-50 opacity-75" : status === "✓" ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`}>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className={`font-medium ${status === "x" ? "text-slate-500 line-through" : "text-slate-800"}`}>{item.item}</p>
                              {item.checklist_type === "packing" && item.must_have && <span className="inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-700">✔️ Must have</span>}
                            </div>
                            {(item.quantity || item.due_date || item.notes) && <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-slate-500">{[item.quantity ? `Qty: ${item.quantity}` : "", item.due_date ? `Due: ${item.due_date}` : "", item.notes || ""].filter(Boolean).join(" · ")}</p>}
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button type="button" disabled={checklistSavingId === item.item_id} onClick={() => void setChecklistStatus(item, status === "✓" ? "" : "✓")} className={`rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50 ${status === "✓" ? "border-emerald-800 bg-emerald-800 text-white" : "border-slate-300 bg-white text-slate-700"}`}>{status === "✓" ? "✓ Done" : "□ Mark done"}</button>
                              <button type="button" disabled={checklistSavingId === item.item_id} onClick={() => void setChecklistStatus(item, status === "x" ? "" : "x")} className={`rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50 ${status === "x" ? "border-slate-500 bg-slate-600 text-white" : "border-slate-300 bg-white text-slate-600"}`}>{status === "x" ? "x Ignored" : "Not applicable"}</button>
                              {checklistSavingId === item.item_id && <span className="self-center text-xs text-slate-500">Syncing…</span>}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <button type="button" disabled={safeChecklistCategoryIndex === 0} onClick={() => setChecklistCategoryIndex((index) => Math.max(0, index - 1))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40">← Previous</button>
                      <span className="text-xs text-slate-500">{safeChecklistCategoryIndex + 1} / {checklistCategories.length} · Swipe to switch</span>
                      <button type="button" disabled={safeChecklistCategoryIndex >= checklistCategories.length - 1} onClick={() => setChecklistCategoryIndex((index) => Math.min(checklistCategories.length - 1, index + 1))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40">Next →</button>
                    </div>
                  </>
                ) : (
                  <p className="mt-4 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">No checklist items were returned from Google Sheets. Confirm the “Things to do & bring” tab and its headers are configured.</p>
                )}
                {checklistMessage && <p className="mt-3 text-sm text-slate-600" aria-live="polite">{checklistMessage}</p>}
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
                  Your shared trip, itinerary and travel memories belong
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
                <button type="button" onClick={goToDashboard} className="text-sm font-semibold text-emerald-800 hover:underline">← Back to dashboard</button>
                <div className="mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-3xl" aria-hidden="true">{activeView === "expenses" ? "💳" : activeView === "memories" ? "📸" : "🗺️"}</div>
                <h2 className="mt-4 text-2xl font-bold">{activeView === "expenses" ? "Trip expenses" : activeView === "memories" ? "Travel memories" : "Trip map"}</h2>
                {activeView === "expenses" ? <div className="mt-5 space-y-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-semibold uppercase text-slate-500">Pre-trip recorded</p><p className="mt-2 text-xl font-bold">{formatExpenseTotal(preTripExpenses)}</p><p className="mt-1 text-xs text-slate-500">Flights, deposits and advance bookings</p></div>
                    <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-semibold uppercase text-slate-500">Actual trip spending</p><p className="mt-2 text-xl font-bold">{formatExpenseTotal(actualTripExpenses)}</p><p className="mt-1 text-xs text-slate-500">Spending during the trip</p></div>
                    <div className="rounded-xl border border-slate-200 p-4"><p className="text-xs font-semibold uppercase text-slate-500">Records</p><p className="mt-2 text-xl font-bold">{expenses.length}</p><p className="mt-1 text-xs text-slate-500">Shared expense entries</p></div>
                  </div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Expense type">
                    <button type="button" onClick={() => setExpenseType("pre-trip")} className={`rounded-full border px-4 py-2 text-sm font-semibold ${expenseType === "pre-trip" ? "border-emerald-800 bg-emerald-800 text-white" : "border-slate-300 bg-white text-slate-700"}`}>Pre-trip</button>
                    <button type="button" onClick={() => setExpenseType("actual-trip")} className={`rounded-full border px-4 py-2 text-sm font-semibold ${expenseType === "actual-trip" ? "border-emerald-800 bg-emerald-800 text-white" : "border-slate-300 bg-white text-slate-700"}`}>Actual trip</button>
                  </div>
                  <form onSubmit={(event) => void saveExpense(event)} className="rounded-xl border border-slate-200 p-4">
                    <h3 className="font-semibold">Add {expenseType === "pre-trip" ? "pre-trip expense" : "actual trip expense"}</h3>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <label className="text-sm font-medium">Date<input type="date" required value={expenseDate} onChange={(event) => setExpenseDate(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>
                      <label className="text-sm font-medium">Paid by<select value={expensePaidBy} onChange={(event) => setExpensePaidBy(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal"><option>Ralph</option><option>June</option><option>Shared</option></select></label>
                      <label className="text-sm font-medium sm:col-span-2">Description<input required maxLength={200} value={expenseDescription} onChange={(event) => setExpenseDescription(event.target.value)} placeholder="e.g. Campervan deposit" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>
                      <label className="text-sm font-medium">Category<select value={expenseCategory} onChange={(event) => setExpenseCategory(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal">{["Flights", "Campervan", "Accommodation", "Insurance", "Bookings & activities", "Fuel", "Groceries", "Meals", "Parking & transport", "Shopping", "Other"].map((category) => <option key={category}>{category}</option>)}</select></label>
                      <div className="grid grid-cols-[1fr_100px] gap-2"><label className="text-sm font-medium">Amount<input type="number" min="0.01" step="0.01" required value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} placeholder="0.00" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label><label className="text-sm font-medium">Currency<select value={expenseCurrency} onChange={(event) => setExpenseCurrency(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-2 font-normal"><option>NZD</option><option>MYR</option><option>AUD</option><option>USD</option></select></label></div>
                      <label className="text-sm font-medium sm:col-span-2">Notes (optional)<textarea rows={2} maxLength={1000} value={expenseNotes} onChange={(event) => setExpenseNotes(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" /></label>
                    </div>
                    <button type="submit" disabled={expenseSaving} className="mt-4 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{expenseSaving ? "Saving…" : "Save expense"}</button>
                    {expenseMessage && <p className="mt-3 text-sm text-slate-600" aria-live="polite">{expenseMessage}</p>}
                  </form>
                  <section><h3 className="font-semibold">Expense records</h3>{expenses.length ? <div className="mt-3 space-y-3">{[...expenses].sort((a,b) => (b.date || "").localeCompare(a.date || "")).map((expense) => <article key={expense.expense_id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold">{expense.description}</p><p className="mt-1 text-xs text-slate-500">{expense.date || "Planned / booked"} · {expense.category} · Paid by {expense.paid_by}</p><span className="mt-2 inline-block rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{expense.expense_type === "pre-trip" ? "Pre-trip" : "Actual trip"}{expense.source === "FINAL EXPENSES" ? " · From planning sheet" : ""}</span>{expense.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{expense.notes}</p>}</div><p className="shrink-0 font-bold">{formatMoney(Number(expense.amount), expense.currency)}</p></div></article>)}</div> : <p className="mt-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">No expenses returned from Google Sheets yet.</p>}</section>
                </div> : activeView === "map" ? <div className="mt-5 space-y-4"><p className="max-w-xl text-sm leading-6 text-slate-600">Open a day's route in Google Maps for driving directions. Flight days open a location search instead of driving directions.</p>{tripDays.map((day, index) => { const routeEntry = getEntriesForDay(day).find((entry) => /^(route|route\s*\/.*|route\s*and.*)$/i.test(entry.label.trim())) || getEntriesForDay(day).find((entry) => /route/i.test(entry.label)); const routeText = routeEntry?.value.trim() || ""; return <article key={day.key} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Day {index + 1} · {day.date}</p><h3 className="mt-1 font-semibold">{routeText || "Route not entered"}</h3></div><span aria-hidden="true" className="text-2xl">🛣️</span></div>{routeText ? <a href={googleMapsUrl(routeText)} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-900">{/\b(KUL|SIN)\b|flight|airport transfer/i.test(routeText) ? "Open locations in Google Maps ↗" : "Open driving route in Google Maps ↗"}</a> : <p className="mt-2 text-sm text-slate-500">Add route details to this day's itinerary to enable directions.</p>}</article>; })}<p className="text-xs text-slate-500">Google Maps opens separately. Route accuracy depends on the place names in your itinerary.</p></div> : <div className="mt-5 space-y-5">
                  <form onSubmit={(event) => { event.preventDefault(); setMemoryPreviewOpen(true); setMemoryMessage(""); }} className="rounded-xl border border-slate-200 p-4">
                    <h3 className="font-semibold">Add a shared memory</h3><p className="mt-1 text-sm text-slate-500">Review the preview before saving. Memories are shared with both approved travellers.</p>
                    <label className="mt-4 block text-sm font-medium">Trip date</label><select value={memoryDate} onChange={(event) => setMemoryDate(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">{!tripDays.some((day) => normalizeTripDate(day.date) === normalizeTripDate(memoryDate)) && <option value={memoryDate}>Today · {memoryDate}</option>}{tripDays.map((day) => <option key={day.key} value={day.date}>{day.date}</option>)}</select>
                    <label className="mt-3 block text-sm font-medium">Attraction / place</label><div className="mt-1 flex gap-2"><input value={memoryAttraction} onChange={(event) => setMemoryAttraction(event.target.value)} required maxLength={160} placeholder="e.g. Lake Tekapo" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" /><button type="button" onClick={() => void detectMemoryPlace()} disabled={isDetectingPlace} className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50">{isDetectingPlace ? "Locating…" : "📍 Use GPS"}</button></div>
                    <label className="mt-3 block text-sm font-medium">Memory</label><textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} required maxLength={5000} rows={4} placeholder="What would you like to remember about this place?" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <label className="mt-3 block text-sm font-medium">Photos</label><input type="file" accept="image/*" multiple onChange={(event) => setMemoryPhotoFiles(Array.from(event.target.files ?? []))} className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-emerald-50 file:px-3 file:py-2 file:font-semibold file:text-emerald-800" />
                    {memoryPhotoFiles.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{memoryPhotoFiles.map((file, index) => <span key={`${file.name}-${index}`} className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700">📷 {file.name}</span>)}</div>}
                    <p className="mt-1 text-xs text-slate-500">Up to 4 photos, 4 MB each. First-time photo upload may require reconnecting Google Sheets to approve Drive file access.</p>
                    <button type="submit" className="mt-3 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white">Preview memory</button>
                  </form>
                  {memoryPreviewOpen && <section className="rounded-xl border border-emerald-300 bg-emerald-50/50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Preview — not saved yet</p><h3 className="mt-2 font-semibold">{memoryAttraction}</h3><p className="mt-1 text-xs text-slate-500">{memoryDate}</p><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{memoryContent}</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void saveMemory()} disabled={isSavingMemory} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{isSavingMemory ? "Saving…" : "Confirm & save"}</button><button type="button" onClick={() => setMemoryPreviewOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold">Keep editing</button></div></section>}
                  {memoryMessage && <p className="text-sm text-slate-600" aria-live="polite">{memoryMessage}</p>}
                  <section><h3 className="font-semibold">Shared memory collection</h3>{memories.length ? <div className="mt-3 space-y-3">{[...memories].sort((a,b) => (a.trip_date || "").localeCompare(b.trip_date || "")).map((memory) => <article key={memory.memory_id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-semibold">{memory.attraction}</h4><span className="text-xs text-slate-500">{memory.trip_date}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{memory.content}</p>{getMemoryPhotoIds(memory.photo_ids).length > 0 && <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{getMemoryPhotoIds(memory.photo_ids).map((photoId) => <a key={photoId} href={`https://drive.google.com/uc?export=view&id=${encodeURIComponent(photoId)}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-slate-200"><img src={`https://drive.google.com/uc?export=view&id=${encodeURIComponent(photoId)}`} alt={`Photo for ${memory.attraction}`} loading="lazy" className="h-32 w-full object-cover" /><span className="block px-2 py-1 text-xs font-semibold text-emerald-800">Open photo ↗</span></a>)}</div>}<p className="mt-2 text-xs text-slate-500">Shared by {memory.author_email || "trip companion"}</p></article>)}</div> : <p className="mt-2 text-sm text-slate-500">No shared memories have been saved yet.</p>}</section>

                </div>}
              </section>
            )}
          </>
        )}
      </main>

      {locationModalSession && selectedDay && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLocationModalSession(null); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="session-location-title" className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-emerald-800">{selectedDay.date} · {locationModalSession}</p><h2 id="session-location-title" className="mt-1 text-xl font-bold">Edit session location</h2><p className="mt-1 text-sm text-slate-500">Changes sync to the SESSION LOCATION Google Sheet.</p></div><button type="button" aria-label="Close location editor" onClick={() => setLocationModalSession(null)} className="rounded-lg px-3 py-2 text-lg hover:bg-slate-100">✕</button></div>
            <label className="mt-5 block text-sm font-semibold" htmlFor="session-location-input">Planned location</label>
            <textarea id="session-location-input" autoFocus rows={3} value={locationDrafts[`${selectedDay.date}|${locationModalSession}`] ?? getSessionLocation(locationModalSession)} onChange={(event) => setLocationDrafts((current) => ({ ...current, [`${selectedDay.date}|${locationModalSession}`]: event.target.value }))} placeholder={`Where will you be during ${locationModalSession.toLowerCase()}?`} className="mt-2 w-full rounded-xl border border-slate-300 p-3 text-sm focus:border-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-100" />
            {locationMessage && <p className="mt-2 text-sm text-slate-600" aria-live="polite">{locationMessage}</p>}
            <div className="mt-4 flex gap-2"><button type="button" onClick={() => setLocationModalSession(null)} className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold">Cancel</button><button type="button" disabled={locationSaving === `${selectedDay.date}|${locationModalSession}` || !(locationDrafts[`${selectedDay.date}|${locationModalSession}`] ?? getSessionLocation(locationModalSession)).trim()} onClick={async () => { await saveSessionLocation(locationModalSession); }} className="flex-1 rounded-xl bg-emerald-800 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{locationSaving === `${selectedDay.date}|${locationModalSession}` ? "Saving…" : "Save & sync"}</button></div>
          </section>
        </div>
      )}

      {showDriveAccessModal && verifiedEmail && selectedTripId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="drive-access-title">
          <section className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xl" aria-hidden="true">🔐</div>
              <div className="min-w-0 flex-1">
                <h2 id="drive-access-title" className="text-lg font-bold">Google Drive access needed</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">Google Drive permission is needed to upload memory photos. Reconnect your Google account and approve the requested Drive access. You can cancel and continue without uploading photos.</p>
              </div>
              <button type="button" aria-label="Close Drive access message" onClick={() => setShowDriveAccessModal(false)} className="rounded-lg px-2 py-1 text-lg text-slate-500 hover:bg-slate-100">✕</button>
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setShowDriveAccessModal(false)} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold">Not now</button>
              <button type="button" onClick={() => window.location.assign("/api/sheets/connect")} className="rounded-xl bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-900">Reconnect Google / Drive</button>
            </div>
          </section>
        </div>
      )}

      {verifiedEmail && selectedTripId && (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-3 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.06)] backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 border-b border-slate-100 py-2">
            <p className="min-w-0 truncate text-xs font-semibold text-slate-600 sm:text-sm">Shared travel companion @ 2026</p>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => { window.scrollTo({ top: 0, behavior: "smooth" }); }} aria-label="Back to top" title="Back to top" className="group flex h-9 w-9 items-center justify-center rounded-full bg-emerald-800 text-lg font-bold text-white shadow-sm transition duration-150 hover:scale-110 hover:bg-emerald-700 hover:shadow-md focus-visible:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 active:scale-105">▲</button>
              <button type="button" onClick={() => setRefreshKey((n) => n + 1)} disabled={isLoadingItinerary} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 disabled:opacity-50 sm:text-sm">{isLoadingItinerary ? "Refreshing…" : "Refresh itinerary"}</button>
            </div>
          </div>
          <div className="mx-auto grid max-w-3xl grid-cols-6 gap-1 py-2">
            {[
              { view: "home" as ViewName, icon: "⌂", label: "Home" },
              { view: "itinerary" as ViewName, icon: "▤", label: "Itinerary" },
              { view: "checklist" as ViewName, icon: "🎒", label: "Checklist" },
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
