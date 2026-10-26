
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
                {activeView !== "memories" ? <><p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">{activeView === "expenses" ? "Shared expense tracking has not been connected yet. No spending total is being fabricated." : "A route map has not been connected yet. This screen does not currently save locations or calculate routes."}</p><div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">Your Google Sheets itinerary remains connected and unchanged.</div></> : <div className="mt-5 space-y-5">
                  <form onSubmit={(event) => { event.preventDefault(); setMemoryPreviewOpen(true); setMemoryMessage(""); }} className="rounded-xl border border-slate-200 p-4">
                    <h3 className="font-semibold">Add a shared memory</h3><p className="mt-1 text-sm text-slate-500">Review the preview before saving. Memories are shared with both approved travellers.</p>
                    <label className="mt-4 block text-sm font-medium">Trip date</label><select value={memoryDate} onChange={(event) => setMemoryDate(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"><option value="">Choose a trip date</option>{tripDays.map((day) => <option key={day.key} value={day.date}>{day.date}</option>)}</select>
                    <label className="mt-3 block text-sm font-medium">Attraction / place</label><input value={memoryAttraction} onChange={(event) => setMemoryAttraction(event.target.value)} required maxLength={160} placeholder="e.g. Lake Tekapo" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <label className="mt-3 block text-sm font-medium">Memory</label><textarea value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} required maxLength={5000} rows={4} placeholder="What would you like to remember about this place?" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                    <button type="submit" className="mt-3 rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white">Preview memory</button>
                  </form>
                  {memoryPreviewOpen && <section className="rounded-xl border border-emerald-300 bg-emerald-50/50 p-4"><p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Preview — not saved yet</p><h3 className="mt-2 font-semibold">{memoryAttraction}</h3><p className="mt-1 text-xs text-slate-500">{memoryDate}</p><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{memoryContent}</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void saveMemory()} disabled={isSavingMemory} className="rounded-lg bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{isSavingMemory ? "Saving…" : "Confirm & save"}</button><button type="button" onClick={() => setMemoryPreviewOpen(false)} className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold">Keep editing</button></div></section>}
                  {memoryMessage && <p className="text-sm text-slate-600" aria-live="polite">{memoryMessage}</p>}
                  <section><h3 className="font-semibold">Shared memory collection</h3>{memories.length ? <div className="mt-3 space-y-3">{[...memories].sort((a,b) => (a.trip_date || "").localeCompare(b.trip_date || "")).map((memory) => <article key={memory.memory_id} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-semibold">{memory.attraction}</h4><span className="text-xs text-slate-500">{memory.trip_date}</span></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{memory.content}</p><p className="mt-2 text-xs text-slate-500">Shared by {memory.author_email || "trip companion"}</p></article>)}</div> : <p className="mt-2 text-sm text-slate-500">No shared memories have been saved yet.</p>}</section>
                  <p className="text-xs text-slate-500">Photo uploads are not enabled yet; this form saves text memories only.</p>
                </div>}
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
