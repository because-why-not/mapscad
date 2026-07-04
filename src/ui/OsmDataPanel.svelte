<script>
    import { untrack } from 'svelte';
    import Attribution from './Attribution.svelte';
    import { OSM_DATA_API } from '../osm/dataSources';
    import { parseTrackFile } from '../osm/TrackParser';

    // The OSM "Data" tab body: per-feature download / save-load, plus the object list with
    // mark → enable/disable editing. Owns all data state; the parent (MapPanel) keeps the
    // tab/drawer chrome and forwards its imperative exports here via `bind:this`.
    //
    // Kept deliberately simple for now, but shaped to grow: today it's one flat list per OSM
    // feature; the intent is for this to become a richer scene-graph-style object list.
    let {
        features = [],
        // True once an area is selected (the tab is gated on this upstream; drives the empty-state hint).
        hasSelection = false,
        // Longest selection side in metres — a feature whose sizeLimit it exceeds is too big to download.
        selectionSide = 0,
        // True while this panel is actually visible (drawer open on the Data tab) — gates keyboard nav.
        active = false,
        // Ask the parent to open the drawer on the Data tab (used when an element is selected on the map).
        onRequestOpen = () => {},
        onDownload = () => 0,
        onUpdatePreview = () => {},
        onSaveJson = () => null,
        onLoadJson = () => 0,
        onSelectElement = () => {},
        onSetEnabled = () => {},
        onHoverElement = () => {},
        onMarksChange = () => {},
    } = $props();

    const idleLabel = (f) => `Download ${f.noun}`;
    // A feature can't be downloaded when the selection is larger than its size limit (too many
    // elements) — we show a warning instead of its buttons.
    const isBlocked = (f) => selectionSide > f.sizeLimit;
    const limitLabel = (f) => f.sizeLimit >= 1000 ? `${+(f.sizeLimit / 1000).toFixed(1)} km` : `${f.sizeLimit} m`;

    // Per-feature download UI state, keyed by feature id: { busy, label, ready, error, stale }. `ready`
    // gates "Update preview" / Save. `error` holds the raw message from the last failed download/load
    // (Overpass often 504s / rate-limits), shown verbatim. `stale` is set when the selection is edited
    // (the data is kept + re-projected, but may not cover the shifted area) — cleared on re-download.
    let downloadState = $state(untrack(() =>
        Object.fromEntries(features.map(f => [f.id, { busy: false, label: idleLabel(f), ready: false, error: '', stale: false }]))));
    // The raw object list per feature ({id,name,disabled}[]) and the single selected element (map ↔
    // list), plus a per-feature name filter the user types.
    let elements = $state(untrack(() => Object.fromEntries(features.map(f => [f.id, []]))));
    let filter = $state(untrack(() => Object.fromEntries(features.map(f => [f.id, '']))));
    let selected = $state(null); // { featureId, elementId } | null
    // Marked element ids ({id:true}) per feature — the working selection the Enable/Disable buttons
    // act on. Marking highlights on the map (see the $effect below) but changes nothing until a
    // button is pressed; Cancel just clears the marks.
    let marked = $state(untrack(() => Object.fromEntries(features.map(f => [f.id, {}]))));

    // --- imperative API, forwarded from MapPanel (which index.ts drives) ---
    export function setElements(id, els) { elements[id] = els; marked[id] = {}; }
    // Flag/unflag a feature's data as possibly not covering the (edited) selection.
    export function setStale(id, v) { if (downloadState[id]) downloadState[id].stale = v; }
    export function setSelected(featureId, elementId) {
        selected = featureId !== null && elementId !== null ? { featureId, elementId } : null;
        // Selecting an element (e.g. by clicking it on the map) opens the drawer so the user sees the
        // matching list entry highlighted — the map ↔ list connection.
        if (selected) onRequestOpen();
    }
    export function addMarks(fid, ids) {
        const m = { ...(marked[fid] ?? {}) };
        for (const id of ids) m[id] = true;
        marked[fid] = m;
    }
    // Selection changed / cleared: drop every feature's downloaded data + working state.
    export function reset() {
        selected = null;
        for (const f of features) { downloadState[f.id].ready = false; downloadState[f.id].error = ''; downloadState[f.id].stale = false; elements[f.id] = []; filter[f.id] = ''; marked[f.id] = {}; }
    }

    const isSelected = (fid, eid) => selected?.featureId === fid && selected?.elementId === eid;

    // --- mark elements, then Enable / Disable (apply) or Cancel (discard the marks) ---
    const isMarked = (fid, id) => !!marked[fid]?.[id];
    const hasMarks = (fid) => Object.keys(marked[fid] ?? {}).length > 0;
    function toggleMark(fid, id) {
        const m = { ...(marked[fid] ?? {}) };
        if (m[id]) delete m[id]; else m[id] = true;
        marked[fid] = m;
    }
    // Select All / Invert act on the WHOLE feature list, not just the filtered rows.
    function selectAll(fid) {
        marked[fid] = Object.fromEntries((elements[fid] ?? []).map(e => [e.id, true]));
    }
    function invertSelection(fid) {
        const m = { ...(marked[fid] ?? {}) };
        for (const e of elements[fid] ?? []) { if (m[e.id]) delete m[e.id]; else m[e.id] = true; }
        marked[fid] = m;
    }
    // Enable/disable the marked set, then clear the marks. Map + list update instantly; the preview
    // only changes on the next "Update preview" (index.ts doesn't re-sync on enable/disable).
    function applyEnabled(fid, enabled) {
        const ids = Object.keys(marked[fid] ?? {}).map(Number);
        if (ids.length) onSetEnabled(fid, ids, enabled);
        marked[fid] = {};
    }
    function cancelMarks(fid) { marked[fid] = {}; }

    // Clear every feature's marked set (the "Clear selection" button + box-select reset).
    let anyMarks = $derived(features.some(f => hasMarks(f.id)));
    function clearAllMarks() { for (const f of features) marked[f.id] = {}; }

    // Push the ticked set to the map so marked elements are highlighted there too.
    $effect(() => {
        for (const f of features) onMarksChange(f.id, Object.keys(marked[f.id] ?? {}).map(Number));
    });

    // Turn the filter text into a case-insensitive matcher. A plain word like "Booth" is already a
    // valid regex that matches anywhere, so simple substring filtering "just works"; power users can
    // type full regex (e.g. "^Booth (St|Rd)$"). An invalid pattern falls back to a literal substring
    // so a half-typed "[" never wipes the list.
    function makeFilter(text) {
        const t = (text ?? '').trim();
        if (!t) return null;
        try { return new RegExp(t, 'i'); }
        catch { return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    }

    // Per-feature display rows: named elements first (alphabetical), unnamed after (numbered in
    // their stored order), then the name filter applied. Derived so it recomputes on data/filter
    // changes only — and is reused by the keyboard navigation below.
    let visible = $derived.by(() => {
        const out = {};
        for (const f of features) {
            const raw = elements[f.id] ?? [];
            const named = raw.filter(e => e.name).slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            const unnamed = raw.filter(e => !e.name);
            let rows = [
                ...named.map(e => ({ id: e.id, label: e.name, disabled: !!e.disabled })),
                ...unnamed.map((e, i) => ({ id: e.id, label: `${f.label} #${i + 1}`, disabled: !!e.disabled })),
            ];
            const re = makeFilter(filter[f.id]);
            if (re) rows = rows.filter(r => re.test(r.label));
            out[f.id] = rows;
        }
        return out;
    });

    // Keyboard navigation over the visible list (only while this panel is open and not typing in a
    // field): ↑/↓ move the selection, Space marks/unmarks it.
    function moveSelection(dir) {
        let fid = selected?.featureId;
        let rows = fid ? visible[fid] : null;
        if (!rows || !rows.length) {
            const first = features.find(f => (visible[f.id] ?? []).length);
            if (!first) return;
            rows = visible[first.id];
            onSelectElement(first.id, (dir > 0 ? rows[0] : rows[rows.length - 1]).id);
            return;
        }
        const idx = rows.findIndex(r => r.id === selected.elementId);
        const next = idx === -1 ? 0 : idx + dir;
        if (next < 0 || next >= rows.length) return; // stay put at the ends
        onSelectElement(fid, rows[next].id);
    }
    function onKeyDown(e) {
        if (!active) return;
        const el = e.target;
        const tag = el?.tagName;
        // Block only real text entry (the filter box); arrows/space still work over the list when a
        // checkbox/button/the page has focus.
        if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && el.type !== 'checkbox')) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
        else if (e.key === ' ' || e.key === 'Spacebar') {
            // Space ticks/unticks the selected element. If a checkbox itself has focus, let the browser
            // toggle it natively instead so it isn't toggled twice.
            if (tag === 'INPUT' && el.type === 'checkbox') return;
            e.preventDefault();
            if (selected) toggleMark(selected.featureId, selected.elementId);
        }
    }

    // Scroll the selected row into view once the menu/list has rendered (it stays in the DOM even
    // when the panel is slid off-screen, so the query works regardless of open state).
    $effect(() => {
        const sel = selected;
        if (!sel) return;
        requestAnimationFrame(() => {
            document.querySelector(`[data-osm-el="${sel.featureId}:${sel.elementId}"]`)?.scrollIntoView({ block: 'nearest' });
        });
    });

    async function downloadFeature(f) {
        const st = downloadState[f.id];
        if (st.busy) return;
        st.busy = true;
        st.label = 'Downloading…';
        st.error = ''; // clear any previous failure before retrying
        try {
            const count = await onDownload(f.id);
            st.stale = false; // fresh data for the current area
            st.ready = count > 0;
            st.label = count ? `${count} ${f.noun}` : `No ${f.noun} found`;
        } catch (e) {
            st.label = 'Download failed';
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
            setTimeout(() => st.label = idleLabel(f), 2500);
        }
    }

    // Save the current (possibly edited) element set to a file the user can keep and re-load.
    function saveJson(getJson, filename) {
        const json = getJson();
        if (!json) return;
        const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // One hidden file input reused for every feature; `loadTargetId` remembers which Load button
    // opened it. Reading a saved file re-ingests its data exactly like a fresh download.
    let fileInput = $state();
    let loadTargetId = null;
    function pickLoad(id) { loadTargetId = id; fileInput.click(); }
    async function loadJson(e) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-selecting the same file fires onchange again
        const f = features.find(x => x.id === loadTargetId);
        if (!file || !f) return;
        const st = downloadState[f.id];
        st.error = '';
        try {
            const text = await file.text();
            // JSON files are saved feature sets; anything else is a GPS track (GPX/TCX) parsed into
            // the same id-less `{ name, coords }` array that onLoadJson already ingests.
            const data = file.name.toLowerCase().endsWith('.json')
                ? JSON.parse(text)
                : parseTrackFile(text, file.name);
            const count = onLoadJson(f.id, data);
            st.stale = false;
            st.ready = count > 0;
            st.label = count ? `${count} ${f.noun}` : `No ${f.noun} found`;
        } catch (e) {
            st.label = 'Load failed';
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            setTimeout(() => st.label = idleLabel(f), 2500);
        }
    }
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- OpenStreetMap data tab: download / reuse / edit tracks + buildings for the selection. -->
<div class="overflow-y-auto flex-1 py-2">
    {#if !hasSelection}
        <p class="px-4 py-2 text-sm opacity-60">Select an area on the map to download OpenStreetMap data for it.</p>
    {:else}
        <!-- Box-select hint + a way to drop the whole marked set across all features. -->
        <div class="px-4 py-2 flex items-center gap-2 border-b border-base-300">
            <span class="text-xs opacity-60 flex-1">Drag a box on the map to select objects.</span>
            <button class="btn btn-xs" disabled={!anyMarks} onclick={clearAllMarks}>Clear selection</button>
        </div>
        <!-- One section per registry feature; entirely data-driven from `features`. -->
        {#each features as f (f.id)}
            {@const st = downloadState[f.id]}
            {@const total = (elements[f.id] ?? []).length}
            {@const rows = visible[f.id] ?? []}
            {@const filtering = !!(filter[f.id] ?? '').trim()}
            <div class="px-4 py-1 mt-2 first:mt-0 text-xs font-bold uppercase tracking-wider opacity-50">
                {f.label}{#if total}<span class="ml-1 font-normal normal-case opacity-70">({filtering ? `${rows.length}/${total}` : total})</span>{/if}
            </div>
            {#if isBlocked(f)}
                <!-- Selection too large for this feature: block the download, explain why. -->
                <div class="px-4 py-2">
                    <div role="alert" class="alert alert-warning py-2 text-xs">
                        <span>Area too large for {f.noun}. Zoom in or shrink the selection to under {limitLabel(f)} per side to download them.</span>
                    </div>
                </div>
            {:else}
            <div class="px-4 py-2 flex flex-col gap-2">
                <button class="btn btn-sm btn-block" title="Download {f.noun} in the selected area" onclick={() => downloadFeature(f)} disabled={st.busy}>
                    {#if st.busy}<span class="loading loading-spinner loading-xs"></span>{/if}
                    {st.label}
                </button>
                <button class="btn btn-sm btn-block" title="Update the 3D preview with the enabled {f.noun}" onclick={() => onUpdatePreview(f.id)} disabled={!st.ready}>Update preview</button>
                <div class="flex gap-2">
                    <button class="btn btn-sm flex-1" title="Save the {f.noun} as a JSON file" onclick={() => saveJson(() => onSaveJson(f.id), `${f.id}.json`)} disabled={!st.ready}>Save</button>
                    <button class="btn btn-sm flex-1" title="Load {f.noun} from a saved JSON file, or a GPX/TCX track" onclick={() => pickLoad(f.id)}>Load</button>
                </div>
                <!-- The selection was edited after downloading: data is kept + re-projected, but may
                     not cover the shifted area. Cleared once re-downloaded. -->
                {#if st.stale}
                    <div role="alert" class="alert alert-warning py-1 text-xs">
                        <span>Selection changed — data may not cover the new area. Re-download to refresh.</span>
                    </div>
                {/if}
                <!-- Raw error from the last failed download/load (e.g. Overpass "504 Gateway Timeout"). -->
                {#if st.error}
                    <textarea class="textarea textarea-bordered textarea-xs w-full h-16 font-mono text-xs text-error resize-y whitespace-pre" readonly aria-label="{f.label} download error">{st.error}</textarea>
                {/if}
            </div>
            <!-- Filter + object list. Type a word ("Booth") for a substring match, or full regex.
                 Mark rows (checkbox / Space, ↑/↓ to move) — Select All / Invert help build the set.
                 Enable/Disable applies to the marked set (map + list update at once; the preview
                 changes on the next Update preview). Disabled rows show struck-through. -->
            {#if total}
                <div class="px-4 pb-1 flex items-center gap-2">
                    <input type="search" class="input input-xs input-bordered flex-1 min-w-0" placeholder="Filter by name (regex)…" bind:value={filter[f.id]} />
                    <div class="join">
                        <button class="btn btn-xs join-item" title="Mark every {f.noun} (ignores the filter)" onclick={() => selectAll(f.id)}>Select All</button>
                        <button class="btn btn-xs join-item" title="Flip the marked state of every {f.noun} (ignores the filter)" onclick={() => invertSelection(f.id)}>Invert</button>
                    </div>
                </div>
                {#if rows.length}
                    <ul class="mx-4 mb-1 max-h-48 overflow-y-auto rounded border border-base-300 divide-y divide-base-300 text-sm">
                        {#each rows as el (el.id)}
                            <li data-osm-el="{f.id}:{el.id}" class="flex items-center {isSelected(f.id, el.id) ? 'bg-primary text-primary-content' : 'hover:bg-base-300'}"
                                onmouseenter={() => onHoverElement(f.id, el.id)} onmouseleave={() => onHoverElement(null, null)}>
                                <input type="checkbox" class="checkbox checkbox-xs ml-2" title="Mark this element" checked={isMarked(f.id, el.id)} onchange={() => toggleMark(f.id, el.id)} />
                                <button class="flex-1 text-left px-2 py-1 truncate bg-transparent border-0 {el.disabled ? 'line-through opacity-50' : ''}" title={el.label} onclick={() => onSelectElement(f.id, el.id)}>{el.label}</button>
                            </li>
                        {/each}
                    </ul>
                {:else}
                    <p class="px-4 pb-2 text-xs opacity-50">No matches.</p>
                {/if}
                <div class="px-4 pb-2 flex gap-2">
                    <button class="btn btn-xs flex-1" disabled={!hasMarks(f.id)} onclick={() => applyEnabled(f.id, true)}>Enable</button>
                    <button class="btn btn-xs flex-1" disabled={!hasMarks(f.id)} onclick={() => applyEnabled(f.id, false)}>Disable</button>
                    <button class="btn btn-xs flex-1" disabled={!hasMarks(f.id)} onclick={() => cancelMarks(f.id)}>Cancel</button>
                </div>
            {/if}
            {/if}
        {/each}
        <input type="file" accept=".json,.gpx,.tcx,application/json" bind:this={fileInput} onchange={loadJson} class="hidden" />
    {/if}

    <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Attribution</div>
    <Attribution attribution={OSM_DATA_API.attribution} />
</div>
