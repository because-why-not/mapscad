<script>
    import { untrack } from 'svelte';

    let {
        style = '',
        tileProviders = [],
        customMaps = [],
        initialActiveProviderId = '',
        initialSunDate = new Date(),
        initialShadows = true,
        onLayerSwitch = () => {},
        onSunChange = () => {},
        onShadowsChange = () => {},
        onSelectToggle = () => {},
        onAspectChange = () => {},
        onDataModeChange = () => {},
        // OSM data: the feature list to render ({id,label,noun,hasRadius}) + generic callbacks.
        osmFeatures = [],
        onOsmFetch = () => 0,
        onOsmAddToPreview = () => {},
        onOsmDownload = () => null,
        onOsmUpload = () => 0,
        onOsmSelectElement = () => {},
        onOsmApplyDeletions = () => {},
        onOsmHoverElement = () => {},
        onOsmMarksChange = () => {},
        initialZoom = 0,
        canCollapse = false,
        onCollapse = () => {},
    } = $props();

    let mountEl;
    export function getMount() { return mountEl; }

    // Live map zoom readout; pushed in from index.ts on every view change.
    let mapZoom = $state(untrack(() => initialZoom));
    export function setZoom(z) { mapZoom = z; }

    let menuOpen = $state(false);
    // Panel-level mode tabs: 'selection' (selection tools + map sources/sun) and 'data'
    // (OpenStreetMap download/edit). The Data tab is gated on a selection existing — see dataEnabled.
    let activeTab = $state('selection');
    let activeProviderId = $state(untrack(() => initialActiveProviderId));
    let providerList = $state(untrack(() => tileProviders));
    let customList = $state(untrack(() => customMaps));
    let dateValue = $state(untrack(() => toDateInput(initialSunDate)));
    let minutesOfDay = $state(untrack(() => initialSunDate.getHours() * 60 + initialSunDate.getMinutes()));
    let shadowsOn = $state(untrack(() => initialShadows));
    // Which selection tool is active: 'none' | 'rectangle' | 'oval'.
    let activeTool = $state('none');
    // True once a selection exists, so the "download tracks" button can appear. Pushed in
    // from index.ts as the selection is drawn / cleared / restored.
    let hasSelection = $state(false);
    // The Data tab is only reachable once an area is selected.
    let dataEnabled = $derived(hasSelection);
    // If the selection is cleared while the user is in Data mode, don't strand them there —
    // fall back to the Selection tab. untrack activeTab so this only fires on hasSelection flipping.
    $effect(() => {
        if (!hasSelection) untrack(() => { if (activeTab === 'data') activeTab = 'selection'; });
    });
    // Tell the map to lock + dim the selection while the Data tab is active (view-only), so the
    // user can't accidentally change the selection there.
    $effect(() => { onDataModeChange(activeTab === 'data'); });
    // True once a download has returned tracks for the current selection, gating the
    // "Add to preview" button. Reset whenever the selection changes (tracks no longer match).
    // Per-feature download UI state, keyed by feature id: { busy, label, ready }. Generic over the
    // registry so a new feature renders with no extra wiring. `ready` gates "Add to preview" and is
    // reset whenever the selection changes (the download no longer matches the new area).
    const idleLabel = (f) => `Download ${f.noun}`;
    let osmState = $state(untrack(() =>
        Object.fromEntries(osmFeatures.map(f => [f.id, { busy: false, label: idleLabel(f), ready: false }]))));
    // The raw object list per feature ({id,name}[]) and the single selected element (map ↔ list),
    // both pushed in from index.ts. Plus a per-feature name filter the user types.
    let osmElements = $state(untrack(() => Object.fromEntries(osmFeatures.map(f => [f.id, []]))));
    let osmFilter = $state(untrack(() => Object.fromEntries(osmFeatures.map(f => [f.id, '']))));
    let osmSelected = $state(null); // { featureId, elementId } | null
    // Staged edit per feature: marked element ids ({id:true}) + a mode saying what Apply does with
    // them — 'remove' deletes the marked, 'keep' deletes everything EXCEPT the marked. Nothing on
    // the map/preview changes until Apply; Cancel discards the marks.
    let osmMarked = $state(untrack(() => Object.fromEntries(osmFeatures.map(f => [f.id, {}]))));
    let osmMode = $state(untrack(() => Object.fromEntries(osmFeatures.map(f => [f.id, 'remove']))));
    export function setOsmElements(id, elements) { osmElements[id] = elements; osmMarked[id] = {}; }
    export function setOsmSelected(featureId, elementId) {
        osmSelected = featureId !== null && elementId !== null ? { featureId, elementId } : null;
        // Selecting an element (e.g. by clicking it on the map) opens the OSM-data menu so the user
        // sees the matching list entry highlighted — the map ↔ list connection. An element selection
        // implies a selection exists, so the Data tab is enabled.
        if (osmSelected) { menuOpen = true; activeTab = 'data'; }
    }
    const isSelected = (fid, eid) => osmSelected?.featureId === fid && osmSelected?.elementId === eid;

    // --- staged deletion: mark elements, then Apply (commit) or Cancel (discard) ---
    const isMarked = (fid, id) => !!osmMarked[fid]?.[id];
    const hasMarks = (fid) => Object.keys(osmMarked[fid] ?? {}).length > 0;
    /** Whether a row will be removed on Apply, given the feature's mode + marks. */
    function willDelete(fid, id) {
        if (osmMode[fid] === 'keep') return hasMarks(fid) && !isMarked(fid, id); // keep marked, drop rest
        return isMarked(fid, id);                                                // remove marked
    }
    function deleteCount(fid) {
        return (osmElements[fid] ?? []).reduce((n, e) => n + (willDelete(fid, e.id) ? 1 : 0), 0);
    }
    function toggleMark(fid, id) {
        const m = { ...(osmMarked[fid] ?? {}) };
        if (m[id]) delete m[id]; else m[id] = true;
        osmMarked[fid] = m;
    }
    function setMode(fid, mode) { osmMode[fid] = mode; osmMarked[fid] = {}; } // switching mode resets marks
    function applyEdits(fid) {
        const ids = (osmElements[fid] ?? []).filter(e => willDelete(fid, e.id)).map(e => e.id);
        if (ids.length) onOsmApplyDeletions(fid, ids);
        osmMarked[fid] = {}; osmMode[fid] = 'remove';
    }
    function cancelEdits(fid) { osmMarked[fid] = {}; osmMode[fid] = 'remove'; }
    // Push the ticked set to the map so marked elements are highlighted there too.
    $effect(() => {
        for (const f of osmFeatures) onOsmMarksChange(f.id, Object.keys(osmMarked[f.id] ?? {}).map(Number));
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
        for (const f of osmFeatures) {
            const raw = osmElements[f.id] ?? [];
            const named = raw.filter(e => e.name).slice()
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            const unnamed = raw.filter(e => !e.name);
            let rows = [
                ...named.map(e => ({ id: e.id, label: e.name })),
                ...unnamed.map((e, i) => ({ id: e.id, label: `${f.label} #${i + 1}` })),
            ];
            const re = makeFilter(osmFilter[f.id]);
            if (re) rows = rows.filter(r => re.test(r.label));
            out[f.id] = rows;
        }
        return out;
    });

    // Keyboard navigation over the visible list (only when the OSM tab is open and not typing in a
    // field): ↑/↓ move the selection, Delete/Backspace removes the selected element and steps on.
    function moveSelection(dir) {
        let fid = osmSelected?.featureId;
        let rows = fid ? visible[fid] : null;
        if (!rows || !rows.length) {
            const first = osmFeatures.find(f => (visible[f.id] ?? []).length);
            if (!first) return;
            rows = visible[first.id];
            onOsmSelectElement(first.id, (dir > 0 ? rows[0] : rows[rows.length - 1]).id);
            return;
        }
        const idx = rows.findIndex(r => r.id === osmSelected.elementId);
        const next = idx === -1 ? 0 : idx + dir;
        if (next < 0 || next >= rows.length) return; // stay put at the ends
        onOsmSelectElement(fid, rows[next].id);
    }
    function onOsmKey(e) {
        if (!menuOpen || activeTab !== 'data') return;
        const el = e.target;
        const tag = el?.tagName;
        // Block only real text entry (the filter box); arrows/space still work over the list when a
        // checkbox/button/the page has focus.
        if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && el.type !== 'checkbox')) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
        else if (e.key === ' ' || e.key === 'Spacebar') {
            // Space ticks/unticks the selected element (staging it). If a checkbox itself has focus,
            // let the browser toggle it natively instead so it isn't toggled twice.
            if (tag === 'INPUT' && el.type === 'checkbox') return;
            e.preventDefault();
            if (osmSelected) toggleMark(osmSelected.featureId, osmSelected.elementId);
        }
    }

    // Scroll the selected row into view once the menu/list has rendered (it stays in the DOM even
    // when the panel is slid off-screen, so the query works regardless of open state).
    $effect(() => {
        const sel = osmSelected;
        if (!sel) return;
        requestAnimationFrame(() => {
            document.querySelector(`[data-osm-el="${sel.featureId}:${sel.elementId}"]`)?.scrollIntoView({ block: 'nearest' });
        });
    });
    export function setHasSelection(has) {
        hasSelection = has;
        osmSelected = null;
        for (const f of osmFeatures) { osmState[f.id].ready = false; osmElements[f.id] = []; osmFilter[f.id] = ''; osmMarked[f.id] = {}; osmMode[f.id] = 'remove'; }
    }

    async function fetchOsm(f) {
        const st = osmState[f.id];
        if (st.busy) return;
        st.busy = true;
        st.label = 'Downloading…';
        try {
            const count = await onOsmFetch(f.id);
            st.ready = count > 0;
            st.label = count ? `${count} ${f.noun}` : `No ${f.noun} found`;
        } catch {
            st.label = 'Download failed';
        } finally {
            st.busy = false;
            setTimeout(() => st.label = idleLabel(f), 2500);
        }
    }

    // Save the raw downloaded JSON to a file the user can keep and re-upload.
    function downloadJson(getJson, filename) {
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

    // One hidden file input reused for every feature; `uploadTargetId` remembers which Upload button
    // opened it. Reading a saved file re-ingests its data exactly like a fresh download.
    let osmFileInput = $state();
    let uploadTargetId = null;
    function pickUpload(id) { uploadTargetId = id; osmFileInput.click(); }
    async function uploadOsm(e) {
        const file = e.target.files?.[0];
        e.target.value = ''; // reset so re-selecting the same file fires onchange again
        const f = osmFeatures.find(x => x.id === uploadTargetId);
        if (!file || !f) return;
        const st = osmState[f.id];
        try {
            const json = JSON.parse(await file.text());
            const count = onOsmUpload(f.id, json);
            st.ready = count > 0;
            st.label = count ? `${count} ${f.noun}` : `No ${f.noun} found`;
        } catch {
            st.label = 'Upload failed';
        } finally {
            setTimeout(() => st.label = idleLabel(f), 2500);
        }
    }
    // Aspect-ratio lock for drawing/resizing (session-only). 'free' or a 'w:h' preset, or
    // 'custom' with the two numbers below. Locked to width:height = halfX/halfY.
    let aspectMode = $state('free');
    let customW = $state(4);
    let customH = $state(3);

    function aspectRatio() {
        if (aspectMode === 'free') return null;
        if (aspectMode === 'custom') return customW > 0 && customH > 0 ? customW / customH : null;
        const [w, h] = aspectMode.split(':').map(Number);
        return h > 0 ? w / h : null;
    }
    function emitAspect() { onAspectChange(aspectRatio()); }

    let sunEnabled = $derived(!!customList.find(c => c.id === activeProviderId)?.sun);
    let shadowsCapable = $derived(!!customList.find(c => c.id === activeProviderId)?.shadows);
    let timeLabel = $derived(formatTime(minutesOfDay));

    // Group the menu into sections: ungrouped tile layers under "Map Source", then one
    // section per named category (e.g. Mapterhorn, AWS Terrain) holding that source's raw
    // layer + its 3D maps, then any ungrouped custom maps under "Custom Maps".
    let sections = $derived(buildSections(providerList, customList));

    function buildSections(providers, customs) {
        const order = [];
        for (const e of [...providers, ...customs]) {
            if (e.category && !order.includes(e.category)) order.push(e.category);
        }
        const result = [];
        const looseProviders = providers.filter(p => !p.category);
        if (looseProviders.length) result.push({ title: 'Map Source', items: looseProviders });
        const rank = (name) => name === 'Raw' ? 0 : name.startsWith('2D Hillshade') ? 1 : name.startsWith('3D Hillshade') ? 2 : 3;
        for (const cat of order) {
            const items = [
                ...providers.filter(p => p.category === cat),
                ...customs.filter(c => c.category === cat),
            ].sort((a, b) => rank(a.name) - rank(b.name));
            result.push({ title: cat, items });
        }
        const looseCustoms = customs.filter(c => !c.category);
        if (looseCustoms.length) result.push({ title: 'Custom Maps', items: looseCustoms });
        return result;
    }

    // Accordion: one section open at a time, so a long source list stays manageable. The
    // section holding the active layer auto-opens; clicking a header toggles it.
    let openSection = $state(null);
    let activeSectionTitle = $derived(sections.find(s => s.items.some(i => i.id === activeProviderId))?.title ?? null);
    // Keep the active layer's section open (until the user manually opens another). untrack
    // openSection so this only re-fires when the *active section* changes, not on every toggle.
    $effect(() => {
        const title = activeSectionTitle;
        untrack(() => { if (title && openSection !== title) openSection = title; });
    });
    function toggleSection(title) { openSection = openSection === title ? null : title; }

    // Pushed in from index.ts.
    export function setTileProviders(providers) { providerList = providers; }
    export function setCustomMaps(maps) { customList = maps; }
    export function setActiveProvider(id) { activeProviderId = id; }
    export function setSelectActive(active) { activeTool = active ? 'rectangle' : 'none'; }
    // Highlight the right tool when a saved selection is restored (rectangle | oval | null).
    export function setSelectTool(tool) { activeTool = tool ?? 'none'; }

    function toggleTool(tool) {
        if (activeTool === tool) {
            activeTool = 'none';
            onSelectToggle(false, tool);
        } else {
            activeTool = tool;
            onSelectToggle(true, tool);
        }
    }

    function handleLayerSwitch(id) {
        if (id === activeProviderId) return;
        activeProviderId = id;
        menuOpen = false;
        onLayerSwitch(id);
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function toDateInput(date) {
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }
    function formatTime(minutes) {
        return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    }
    function composeSunDate() {
        const [y, m, d] = dateValue.split('-').map(Number);
        return new Date(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
    }
    function emitSun() {
        if (dateValue) onSunChange(composeSunDate());
    }
    function setSunNow() {
        const now = new Date();
        dateValue = toDateInput(now);
        minutesOfDay = now.getHours() * 60 + now.getMinutes();
        onSunChange(now);
    }
    function toggleShadows() {
        onShadowsChange(shadowsOn);
    }
</script>

<svelte:window onkeydown={onOsmKey} />

<div class="panel panel-map" {style}>
    <div class="panel-mount" id="map-mount" bind:this={mountEl}></div>

    <!-- Selection toolbar (below the map's zoom +/- control). Hidden in Data mode so the
         selection can't be changed while the user works with downloaded data. -->
    {#if activeTab === 'selection'}
    <div class="absolute top-20 left-4 z-[1000] flex flex-col gap-2">
        <button
            class="btn btn-square shadow-md border-0 {activeTool === 'rectangle' ? 'btn-primary' : 'bg-base-100'}"
            title="Select rectangular area"
            aria-label="Select rectangular area"
            onclick={() => toggleTool('rectangle')}
        >⬚</button>
        <button
            class="btn btn-square shadow-md border-0 {activeTool === 'oval' ? 'btn-primary' : 'bg-base-100'}"
            title="Select oval area"
            aria-label="Select oval area"
            onclick={() => toggleTool('oval')}
        >◯</button>

        {#if activeTool !== 'none'}
            <!-- Aspect-ratio lock: snaps the selection to a frame ratio (1:1 = square/circle). -->
            <select
                class="select select-sm bg-base-100 shadow-md border-0 w-24"
                title="Lock aspect ratio"
                aria-label="Lock aspect ratio"
                bind:value={aspectMode}
                onchange={emitAspect}
            >
                <option value="free">Free</option>
                <option value="1:1">1:1</option>
                <option value="3:2">3:2</option>
                <option value="4:3">4:3</option>
                <option value="16:9">16:9</option>
                <option value="custom">Custom</option>
            </select>
            {#if aspectMode === 'custom'}
                <div class="flex items-center gap-1 bg-base-100 shadow-md rounded px-2 py-1">
                    <input type="number" min="1" step="1" class="input input-xs input-bordered w-12 text-center"
                        bind:value={customW} oninput={emitAspect} aria-label="Ratio width" />
                    <span class="text-sm opacity-60">:</span>
                    <input type="number" min="1" step="1" class="input input-xs input-bordered w-12 text-center"
                        bind:value={customH} oninput={emitAspect} aria-label="Ratio height" />
                </div>
            {/if}
        {/if}
    </div>
    {/if}

    <!-- Mode tabs: switch the panel between Selection (tools + map sources/sun) and Data
         (OpenStreetMap download/edit). Each opens the right-hand drawer to its content. The
         Data tab is disabled until an area is selected. -->
    <div class="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] join shadow-md">
        <button
            class="btn btn-sm join-item border-0 {activeTab === 'selection' ? 'btn-primary' : 'bg-base-100'}"
            onclick={() => { activeTab = 'selection'; menuOpen = true; }}
        >Selection</button>
        <button
            class="btn btn-sm join-item border-0 {activeTab === 'data' ? 'btn-primary' : 'bg-base-100'}"
            disabled={!dataEnabled}
            title={dataEnabled ? 'OpenStreetMap data' : 'Select an area first'}
            onclick={() => { activeTab = 'data'; menuOpen = true; }}
        >Data</button>
    </div>

    <!-- Live zoom readout (sits above the OL scale line at the bottom-left) -->
    <div class="absolute bottom-8 left-2 z-[1000] bg-base-100/90 shadow-md rounded px-2 py-0.5 text-xs font-mono tabular-nums pointer-events-none">
        z{mapZoom.toFixed(1)}
    </div>

    {#if canCollapse}
        <button class="collapse-btn btn btn-xs btn-circle bg-base-100 border-0 shadow" title="Hide map" onclick={onCollapse}>‹</button>
    {/if}

    <div class="absolute inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
        <!-- Title reflects the active panel tab; the tab itself is switched on the map. -->
        <div class="flex items-center bg-primary text-primary-content">
            <span class="flex-1 px-4 py-3 text-sm font-semibold">{activeTab === 'data' ? 'OSM data' : 'Map'}</span>
            <button class="btn btn-ghost btn-sm btn-circle text-primary-content self-center mx-1" aria-label="Close menu" onclick={() => menuOpen = false}>✕</button>
        </div>

        {#if activeTab === 'selection'}
        <div class="overflow-y-auto flex-1 py-2">
            {#each sections as section (section.title)}
                {@const isOpen = openSection === section.title}
                {@const hasActive = section.items.some(i => i.id === activeProviderId)}
                <button
                    class="w-full flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider hover:bg-base-300 {hasActive ? 'opacity-90' : 'opacity-60'}"
                    onclick={() => toggleSection(section.title)}
                >
                    <span class="text-[0.6rem] transition-transform duration-150 {isOpen ? 'rotate-90' : ''}">▶</span>
                    <span class="flex-1 text-left">{section.title}</span>
                    {#if hasActive && !isOpen}<span class="badge badge-primary badge-xs"></span>{/if}
                    <span class="opacity-50 font-normal normal-case">{section.items.length}</span>
                </button>
                {#if isOpen}
                    <ul class="menu px-2 pt-0">
                        {#each section.items as item (item.id)}
                            <li>
                                <button class={item.id === activeProviderId ? 'active' : ''} onclick={() => handleLayerSwitch(item.id)}>
                                    <span>{item.icon}</span>
                                    {item.name}
                                </button>
                            </li>
                        {/each}
                    </ul>
                {/if}
            {/each}

            {#if sunEnabled}
                <div class="px-4 py-1 mt-2 text-xs font-bold uppercase tracking-wider opacity-50">Sun</div>
                <div class="px-4 py-2 flex flex-col gap-2">
                    <input type="date" class="input input-sm input-bordered w-full" bind:value={dateValue} onchange={emitSun} />
                    <div class="flex items-center gap-2">
                        <input type="range" min="0" max="1439" step="5" class="range range-sm flex-1" bind:value={minutesOfDay} oninput={emitSun} />
                        <span class="text-sm font-mono tabular-nums w-12 text-right">{timeLabel}</span>
                    </div>
                    {#if shadowsCapable}
                        <label class="flex items-center gap-2 cursor-pointer py-1">
                            <input type="checkbox" class="toggle toggle-sm" bind:checked={shadowsOn} onchange={toggleShadows} />
                            <span class="text-sm">Cast shadows</span>
                        </label>
                    {/if}
                    <button class="btn btn-sm btn-outline" onclick={setSunNow}>Now</button>
                </div>
            {/if}
        </div>
        {:else}
        <!-- OpenStreetMap data tab: download / reuse / edit tracks + buildings for the selection. -->
        <div class="overflow-y-auto flex-1 py-2">
            {#if !hasSelection}
                <p class="px-4 py-2 text-sm opacity-60">Select an area on the map to download OpenStreetMap data for it.</p>
            {:else}
                <!-- One section per registry feature; entirely data-driven from `osmFeatures`. -->
                {#each osmFeatures as f (f.id)}
                    {@const st = osmState[f.id]}
                    {@const total = (osmElements[f.id] ?? []).length}
                    {@const rows = visible[f.id] ?? []}
                    {@const filtering = !!(osmFilter[f.id] ?? '').trim()}
                    <div class="px-4 py-1 mt-2 first:mt-0 text-xs font-bold uppercase tracking-wider opacity-50">
                        {f.label}{#if total}<span class="ml-1 font-normal normal-case opacity-70">({filtering ? `${rows.length}/${total}` : total})</span>{/if}
                    </div>
                    <div class="px-4 py-2 flex flex-col gap-2">
                        <button class="btn btn-sm btn-block" title="Download {f.noun} in the selected area" onclick={() => fetchOsm(f)} disabled={st.busy}>
                            {#if st.busy}<span class="loading loading-spinner loading-xs"></span>{/if}
                            {st.label}
                        </button>
                        <button class="btn btn-sm btn-block" title="Add the downloaded {f.noun} to the 3D preview" onclick={() => onOsmAddToPreview(f.id)} disabled={!st.ready}>Add to preview</button>
                        <button class="btn btn-sm btn-block" title="Download the {f.noun} (with your deletions) as a JSON file" onclick={() => downloadJson(() => onOsmDownload(f.id), `${f.id}.json`)} disabled={!st.ready}>Download JSON</button>
                        <button class="btn btn-sm btn-block" title="Load {f.noun} from a previously downloaded JSON file" onclick={() => pickUpload(f.id)}>Upload JSON</button>
                    </div>
                    <!-- Filter + object list. Type a word ("Booth") for a substring match, or full regex.
                         Mark rows (checkbox / Space, ↑/↓ to move); the Remove/Keep toggle decides what Apply does with
                         the marked set. Nothing changes on the map/preview until Apply; Cancel discards. -->
                    {#if total}
                        {@const pending = deleteCount(f.id)}
                        <div class="px-4 pb-1 flex items-center gap-2">
                            <input type="search" class="input input-xs input-bordered flex-1 min-w-0" placeholder="Filter by name (regex)…" bind:value={osmFilter[f.id]} />
                            <div class="join">
                                <button class="btn btn-xs join-item {osmMode[f.id] === 'remove' ? 'btn-active' : ''}" title="Apply deletes the marked elements" onclick={() => setMode(f.id, 'remove')}>Remove</button>
                                <button class="btn btn-xs join-item {osmMode[f.id] === 'keep' ? 'btn-active' : ''}" title="Apply keeps the marked elements and deletes the rest" onclick={() => setMode(f.id, 'keep')}>Keep</button>
                            </div>
                        </div>
                        {#if rows.length}
                            <ul class="mx-4 mb-1 max-h-48 overflow-y-auto rounded border border-base-300 divide-y divide-base-300 text-sm">
                                {#each rows as el (el.id)}
                                    {@const doomed = willDelete(f.id, el.id)}
                                    <li data-osm-el="{f.id}:{el.id}" class="flex items-center {isSelected(f.id, el.id) ? 'bg-primary text-primary-content' : 'hover:bg-base-300'}"
                                        onmouseenter={() => onOsmHoverElement(f.id, el.id)} onmouseleave={() => onOsmHoverElement(null, null)}>
                                        <input type="checkbox" class="checkbox checkbox-xs ml-2" title="Mark this element" checked={isMarked(f.id, el.id)} onchange={() => toggleMark(f.id, el.id)} />
                                        <button class="flex-1 text-left px-2 py-1 truncate bg-transparent border-0 {doomed ? 'line-through opacity-50' : ''}" title={el.label} onclick={() => onOsmSelectElement(f.id, el.id)}>{el.label}</button>
                                    </li>
                                {/each}
                            </ul>
                        {:else}
                            <p class="px-4 pb-2 text-xs opacity-50">No matches.</p>
                        {/if}
                        <div class="px-4 pb-2 flex gap-2">
                            <button class="btn btn-xs btn-primary flex-1" disabled={pending === 0} onclick={() => applyEdits(f.id)}>Apply{#if pending} · delete {pending}{/if}</button>
                            <button class="btn btn-xs flex-1" disabled={!hasMarks(f.id)} onclick={() => cancelEdits(f.id)}>Cancel</button>
                        </div>
                    {/if}
                {/each}
                <input type="file" accept=".json,application/json" bind:this={osmFileInput} onchange={uploadOsm} class="hidden" />
            {/if}
        </div>
        {/if}
    </div>
</div>
